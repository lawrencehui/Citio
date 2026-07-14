import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import type { CitioConfig } from "../config/schema.js";
import { installSkillsTo } from "./skills.js";

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

    try {
      execFileSync("git", ["config", "--global", "user.name", this.config.workspace.git.user_name], {
        stdio: "pipe",
        encoding: "utf-8",
      });

      if (this.config.workspace.git.user_email) {
        execFileSync("git", ["config", "--global", "user.email", this.config.workspace.git.user_email], {
          stdio: "pipe",
          encoding: "utf-8",
        });
      }

      console.log(JSON.stringify({
        type: "git_identity_configured",
        userName: this.config.workspace.git.user_name,
        userEmail: this.config.workspace.git.user_email || null,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        type: "git_identity_configuration_failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    // Configure git to use GH_TOKEN for HTTPS clones
    const ghToken = process.env.GH_TOKEN;
    if (ghToken) {
      try {
        execFileSync("git", ["config", "--global", "credential.helper", `!f() { echo "username=oauth2"; echo "password=${ghToken}"; }; f`], {
          stdio: "pipe",
          encoding: "utf-8",
        });
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

    // Install configured skills into the directory loadSkills() reads.
    // Idempotent (skips already-present skills), non-fatal on failure —
    // this is how skills reach the container, which local installs cannot.
    const configuredSkills = this.config.skills?.installed ?? [];
    if (configuredSkills.length > 0) {
      const results = installSkillsTo(configuredSkills, this.config.skills.directory, { ghToken });
      for (const result of results) {
        console.log(JSON.stringify({ type: "skill_install", ...result }));
      }
    }

    this.generateInstructionFiles();
  }

  private generateInstructionFiles(): void {
    const skills = this.loadSkills();

    // User-configured rules from citio.yaml, falling back to the defaults.
    const configuredRules = this.config.workspace?.rules ?? [];
    const rules = configuredRules.length > 0 ? configuredRules : [
      "Always create PRs for code changes. Never push directly to main.",
      "When investigating bugs, check logs first before making code changes.",
      "Report findings back to the team with clear summaries.",
    ];

    const baseInstructionContent = `# Citio Agent Instructions

## Rules
${rules.map((rule) => `- ${rule}`).join("\n")}
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
0. For simple status/info questions (what's running, service health, quick lookups):
   answer with MINIMAL tool calls (1-3) — skip recall_context, skip query_audit_log,
   don't chain tools you don't need. Speed matters more than ceremony.
0b. When asked about a resource BY NAME (a service, cluster, app) and you don't find
   an exact match: enumerate before asking back — e.g. list all ECS clusters, then
   list services in each, and fuzzy-match ("Checkout" ~ checkout-service-prod,
   "Billing" ~ billing-api). People use short names; infrastructure uses long ones.
   Only ask the user when enumeration genuinely finds no plausible match.
1. When asked to investigate a bug, use investigate_codebase and read_file first
2. For CloudWatch or AWS checks, use query_logs first and only use run_command when query_logs is not enough
3. Prefer these MCP tools over native Bash/Grep/Glob/Read tools whenever possible
4. Use post_update for meaningful progress checkpoints, not every trivial step
5. Use recall_context before starting non-trivial investigations, not for simple questions
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
    const index: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;

      // Progressive disclosure: inlining full SKILL.md bodies added ~60KB to
      // EVERY agent request (verified: multi-minute responses). Give the agent
      // a one-line index and let it read the file when the task matches.
      const content = readFileSync(skillPath, "utf-8");
      let description = "";
      const fmMatch = content.match(/^---\n[\s\S]*?\bdescription:\s*(.+)/m);
      if (fmMatch) description = fmMatch[1].trim().replace(/^["']|["']$/g, "");
      if (!description) {
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
        description = (body.split("\n").find((line) => line.trim() && !line.trim().startsWith("#")) || "").trim().slice(0, 200);
      }
      index.push(`- **${entry.name}** — ${description}\n  Full instructions: read \`${skillPath}\``);
    }

    if (index.length === 0) return "";
    return (
      `\n# Installed Skills\n\n` +
      `These skills are installed on disk. When a task matches one, READ its SKILL.md (path below) and follow it — do not guess its contents:\n\n` +
      index.join("\n")
    );
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
