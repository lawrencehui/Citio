import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import type { CitioConfig } from "../config/schema.js";

export class WorkspaceManager {
  private workspacePath: string;
  private config: CitioConfig;

  constructor(config: CitioConfig, workspacePath = "/workspace") {
    this.config = config;
    this.workspacePath = workspacePath;
  }

  getMainWorkspacePath(): string {
    return this.workspacePath;
  }

  async initialize(): Promise<void> {
    mkdirSync(this.workspacePath, { recursive: true });

    // Configure git to use GH_TOKEN for HTTPS clones
    const ghToken = process.env.GH_TOKEN;
    if (ghToken) {
      try {
        execSync(
          `git config --global credential.helper '!f() { echo "username=oauth2"; echo "password=${ghToken}"; }; f'`,
          { stdio: "pipe" }
        );
        console.log(JSON.stringify({ type: "git_credential_configured" }));
      } catch {
        // Non-fatal, try URL injection as fallback
      }
    }

    // Ensure workspace is a git repo (Codex requires it)
    if (!existsSync(path.join(this.workspacePath, ".git"))) {
      try {
        execSync("git init", { cwd: this.workspacePath, stdio: "pipe" });
        console.log(JSON.stringify({ type: "workspace_git_init" }));
      } catch {
        // Non-fatal
      }
    }

    for (const repo of this.config.workspace.repos) {
      const repoName = this.extractRepoName(repo.url);
      const repoPath = path.join(this.workspacePath, repoName);

      // Inject token into URL as fallback for credential helper
      const cloneUrl = ghToken
        ? repo.url.replace("https://github.com/", `https://${ghToken}@github.com/`)
        : repo.url;

      if (existsSync(repoPath)) {
        console.log(
          JSON.stringify({
            type: "workspace_pull",
            repo: repoName,
          })
        );
        try {
          execSync(`git pull --ff-only`, {
            cwd: repoPath,
            encoding: "utf-8",
            timeout: 60000,
          });
        } catch (err) {
          console.log(
            JSON.stringify({
              type: "workspace_pull_failed",
              repo: repoName,
              error:
                err instanceof Error ? err.message : String(err),
            })
          );
        }
      } else {
        console.log(
          JSON.stringify({
            type: "workspace_clone",
            repo: repoName,
            url: repo.url,
          })
        );
        try {
          execSync(
            `git clone --depth 1 --branch "${repo.branch}" "${cloneUrl}" "${repoPath}"`,
            {
              encoding: "utf-8",
              timeout: 300000,
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            }
          );
        } catch (err) {
          console.log(
            JSON.stringify({
              type: "workspace_clone_failed",
              repo: repoName,
              error: err instanceof Error ? err.message : String(err),
            })
          );
          // Don't crash — continue with other repos
          continue;
        }
      }
    }

    this.generateInstructionFiles();
  }

  private generateInstructionFiles(): void {
    const skills = this.loadSkills();

    const baseInstructionContent = `# Citio Agent Instructions

## Rules
- Always create PRs for code changes. Never push directly to main.
- When investigating bugs, check logs first before making code changes.
- Report findings back to the team with clear summaries.
- After any update or change pushed to a PR, always quote the PR link in your response.

## Available MCP Tools
You have access to these tools via the MCP server:
- investigate_codebase: Search code for patterns
- read_file: Read file contents
- write_file: Create or edit files
- create_branch: Create a git branch with isolated worktree
- create_pr: Open a pull request on GitHub
- run_command: Run allowlisted commands (git, npm, tsc, etc.)
- check_ci_status: Check CI/CD status of a PR
- save_finding: Save learnings to org memory
- recall_context: Search saved org memory for prior findings
- query_logs: Query CloudWatch logs from the task role
- post_update: Record a progress update for the current Slack thread
- query_audit_log: Search the recorded MCP tool audit trail

## Workflow
1. When asked to investigate a bug, use investigate_codebase and read_file first
2. For CloudWatch or AWS checks, use query_logs first and only use run_command when query_logs is not enough
3. Prefer these MCP tools over native Bash/Grep/Glob/Read tools whenever possible
4. Use post_update for meaningful progress checkpoints, not every trivial step
5. Use recall_context before repeating prior investigations
6. Create a branch before making changes
7. Create a PR when your fix is ready
8. Save any important findings with save_finding`;

    const instructionContent = skills
      ? `${baseInstructionContent}\n\n${skills}\n`
      : `${baseInstructionContent}\n`;

    // Write CLAUDE.md for Claude Code
    writeFileSync(
      path.join(this.workspacePath, "CLAUDE.md"),
      instructionContent,
      "utf-8"
    );

    // Write AGENTS.md for Codex
    writeFileSync(
      path.join(this.workspacePath, "AGENTS.md"),
      instructionContent,
      "utf-8"
    );
  }

  private loadSkills(): string {
    const skillsDir = this.config.skills.directory;
    if (!existsSync(skillsDir)) return "";

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skillContents: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillPath)) {
          const content = readFileSync(skillPath, "utf-8");
          skillContents.push(`## Skill: ${entry.name}\n\n${content}`);
        }
      }
    }

    if (skillContents.length === 0) return "";
    return `\n# Installed Skills\n\n${skillContents.join("\n\n---\n\n")}`;
  }

  private extractRepoName(url: string): string {
    return url
      .split("/")
      .pop()!
      .replace(/\.git$/, "");
  }

  cleanupWorktree(worktreePath: string): void {
    try {
      const repoDir = path.dirname(worktreePath);
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch (err) {
      console.log(
        JSON.stringify({
          type: "worktree_cleanup_failed",
          path: worktreePath,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}
