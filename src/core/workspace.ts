import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

    for (const repo of this.config.workspace.repos) {
      const repoName = this.extractRepoName(repo.url);
      const repoPath = path.join(this.workspacePath, repoName);

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
        execSync(
          `git clone --depth 1 --branch "${repo.branch}" "${repo.url}" "${repoPath}"`,
          {
            encoding: "utf-8",
            timeout: 300000,
          }
        );
      }
    }

    this.generateInstructionFiles();
  }

  private generateInstructionFiles(): void {
    const rules = this.config.workspace.rules.join("\n- ");
    const skills = this.loadSkills();

    const instructionContent = `# Citio Agent Instructions

## Rules
- ${rules}

## Available MCP Tools
You have access to these tools via the MCP server:
- investigate_codebase: Search code for patterns
- read_file: Read file contents
- write_file: Create or edit files
- create_branch: Create a git branch with isolated worktree
- create_pr: Open a pull request on GitHub
- run_command: Run allowlisted commands (git, npm, tsc, etc.)
- post_update: Send status updates to the Slack thread
- check_ci_status: Check CI/CD status of a PR
- save_finding: Save learnings to org memory

## Workflow
1. When asked to investigate a bug, use investigate_codebase and read_file first
2. Use post_update to keep the team informed of progress
3. Create a branch before making changes
4. Create a PR when your fix is ready
5. Save any important findings with save_finding

${skills}
`;

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

    const fs = require("fs");
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
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
