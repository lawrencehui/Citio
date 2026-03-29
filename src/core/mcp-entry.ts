#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 * Claude Code connects to this via --mcp-config.
 * This process runs as a child of the main Citio process.
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CitioConfigSchema } from "../config/schema.js";
import { resolveEnvVars } from "../utils/env.js";

const COMMAND_ALLOWLIST = new Set([
  "git", "npm", "npx", "tsc", "bun", "python", "python3", "node", "make",
  "ls", "cat", "head", "tail", "grep", "find", "wc", "sort", "uniq",
  "diff", "echo", "test", "gh", "aws", "supabase",
]);

const COMMAND_BLOCKLIST = new Set([
  "curl", "wget", "nc", "ssh", "scp", "rsync", "env", "printenv", "export",
]);

async function main() {
  const configPath = process.env.CITIO_CONFIG || "citio.yaml";
  const workspacePath = process.env.CITIO_WORKSPACE || "/workspace";

  let config;
  try {
    let raw: string;
    if (process.env.CITIO_CONFIG_B64) {
      raw = Buffer.from(process.env.CITIO_CONFIG_B64, "base64").toString("utf-8");
    } else {
      raw = readFileSync(configPath, "utf-8");
    }
    config = CitioConfigSchema.parse(resolveEnvVars(parse(raw)));
  } catch {
    config = null;
  }

  const server = new McpServer({
    name: "citio",
    version: "0.1.0",
  });

  // Tool: investigate_codebase
  server.tool(
    "investigate_codebase",
    "Search the codebase for files, functions, or patterns related to a query",
    { query: z.string().describe("What to search for") },
    async ({ query }) => {
      const { execSync } = await import("child_process");
      try {
        const result = execSync(
          `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.go' --include='*.rs' --include='*.java' --include='*.rb' --include='*.md' -l "${query.replace(/"/g, '\\"')}" . 2>/dev/null | head -20`,
          { cwd: workspacePath, encoding: "utf-8", timeout: 30000 }
        );
        return { content: [{ type: "text" as const, text: `Files matching "${query}":\n${result || "No matches found."}` }] };
      } catch {
        return { content: [{ type: "text" as const, text: `No matches found for "${query}".` }] };
      }
    }
  );

  // Tool: read_file
  server.tool(
    "read_file",
    "Read file contents from the workspace",
    { path: z.string().describe("Relative path from workspace root") },
    async ({ path: filePath }) => {
      const fs = await import("fs/promises");
      const nodePath = await import("path");
      const fullPath = nodePath.resolve(workspacePath, filePath);
      if (!fullPath.startsWith(workspacePath)) {
        return { content: [{ type: "text" as const, text: "Error: path traversal not allowed." }], isError: true };
      }
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        return { content: [{ type: "text" as const, text: content }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool: write_file
  server.tool(
    "write_file",
    "Write content to a file (creates or overwrites)",
    { path: z.string(), content: z.string() },
    async ({ path: filePath, content: fileContent }) => {
      const fs = await import("fs/promises");
      const nodePath = await import("path");
      const fullPath = nodePath.resolve(workspacePath, filePath);
      if (!fullPath.startsWith(workspacePath)) {
        return { content: [{ type: "text" as const, text: "Error: path traversal not allowed." }], isError: true };
      }
      try {
        await fs.mkdir(nodePath.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, fileContent, "utf-8");
        return { content: [{ type: "text" as const, text: `Written ${filePath}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool: create_branch
  server.tool(
    "create_branch",
    "Create a git branch with an isolated worktree",
    { repo: z.string(), branch_name: z.string() },
    async ({ repo, branch_name }) => {
      const { execSync } = await import("child_process");
      const repoPath = `${workspacePath}/${repo}`;
      const worktreePath = `${workspacePath}/${repo}-wt-${branch_name}`;
      try {
        execSync(`git worktree add "${worktreePath}" -b "${branch_name}"`, { cwd: repoPath, encoding: "utf-8", timeout: 30000 });
        return { content: [{ type: "text" as const, text: `Branch "${branch_name}" created at ${worktreePath}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool: create_pr
  server.tool(
    "create_pr",
    "Push branch and create a GitHub pull request",
    { repo: z.string(), title: z.string(), body: z.string(), branch: z.string(), base: z.string().default("main") },
    async ({ repo, title, body, branch, base }) => {
      const { execSync } = await import("child_process");
      const repoPath = `${workspacePath}/${repo}`;
      try {
        execSync(`git push origin "${branch}"`, { cwd: repoPath, encoding: "utf-8", timeout: 60000 });
        const result = execSync(
          `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --head "${branch}" --base "${base}"`,
          { cwd: repoPath, encoding: "utf-8", timeout: 30000 }
        );
        return { content: [{ type: "text" as const, text: `PR created: ${result.trim()}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool: run_command (allowlisted only)
  server.tool(
    "run_command",
    "Run an allowlisted command in the workspace",
    { command: z.string(), cwd: z.string().optional() },
    async ({ command, cwd }) => {
      const { execFileSync } = await import("child_process");
      const nodePath = await import("path");
      const parts = command.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      if (!cmd || COMMAND_BLOCKLIST.has(cmd)) {
        return { content: [{ type: "text" as const, text: `Command "${cmd}" is blocked.` }], isError: true };
      }
      if (!COMMAND_ALLOWLIST.has(cmd)) {
        return { content: [{ type: "text" as const, text: `Command "${cmd}" not in allowlist. Allowed: ${[...COMMAND_ALLOWLIST].join(", ")}` }], isError: true };
      }

      // Reject shell metacharacters to prevent injection
      if (/[;|&`$(){}]/.test(command)) {
        return { content: [{ type: "text" as const, text: "Error: shell metacharacters not allowed. Run one command at a time." }], isError: true };
      }

      const workDir = cwd ? nodePath.resolve(workspacePath, cwd) : workspacePath;
      if (!workDir.startsWith(workspacePath)) {
        return { content: [{ type: "text" as const, text: "Error: path traversal not allowed." }], isError: true };
      }

      try {
        // execFileSync: no shell, prevents injection via metacharacters
        const result = execFileSync(cmd, args, {
          cwd: workDir, encoding: "utf-8", timeout: 120000, maxBuffer: 10 * 1024 * 1024,
        });
        return { content: [{ type: "text" as const, text: result || "(no output)" }] };
      } catch (err: unknown) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        return { content: [{ type: "text" as const, text: `Failed:\n${e.stderr || e.stdout || e.message || String(err)}` }], isError: true };
      }
    }
  );

  // Tool: check_ci_status
  server.tool(
    "check_ci_status",
    "Check CI/CD status of a pull request",
    { repo: z.string(), pr_number: z.number() },
    async ({ repo, pr_number }) => {
      const { execSync } = await import("child_process");
      try {
        const result = execSync(`gh pr checks ${pr_number} --json name,status,conclusion`, {
          cwd: `${workspacePath}/${repo}`, encoding: "utf-8", timeout: 30000,
        });
        return { content: [{ type: "text" as const, text: `CI for PR #${pr_number}:\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // Tool: save_finding
  server.tool(
    "save_finding",
    "Save a finding to organizational memory for future reference",
    { topic: z.string(), content: z.string() },
    async ({ topic, content: findingContent }) => {
      const fs = await import("fs/promises");
      const memoryDir = process.env.CITIO_MEMORY || "/memory";
      const slug = topic.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const filePath = `${memoryDir}/${slug}.md`;
      try {
        await fs.mkdir(memoryDir, { recursive: true });
        const timestamp = new Date().toISOString();
        const entry = `\n\n## ${timestamp}\n\n${findingContent}\n`;
        try {
          await fs.appendFile(filePath, entry, "utf-8");
        } catch {
          await fs.writeFile(filePath, `# ${topic}\n${entry}`, "utf-8");
        }
        return { content: [{ type: "text" as const, text: `Saved to ${filePath}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
