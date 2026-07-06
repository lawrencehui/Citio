#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 * Claude Code and Codex connect to this via MCP.
 */
import "dotenv/config";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
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

const SEARCH_INCLUDES = [
  "--include=*.ts",
  "--include=*.tsx",
  "--include=*.js",
  "--include=*.jsx",
  "--include=*.py",
  "--include=*.go",
  "--include=*.rs",
  "--include=*.java",
  "--include=*.rb",
  "--include=*.md",
];

function createTextResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function resolveUnderRoot(root: string, target = "."): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);

  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("path traversal not allowed");
  }

  return resolved;
}

function runFile(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout?: number; maxBuffer?: number } 
): string {
  return execFileSync(cmd, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function extractExecError(err: unknown): string {
  const candidate = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : candidate.stderr?.toString();
  const stdout = typeof candidate.stdout === "string" ? candidate.stdout : candidate.stdout?.toString();
  return stderr || stdout || candidate.message || String(err);
}

function validateBranchName(branchName: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(branchName) || branchName.startsWith("-") || branchName.includes("..")) {
    throw new Error(`Invalid branch name "${branchName}"`);
  }
}

async function findMemoryMatches(memoryDir: string, query: string): Promise<string> {
  if (!existsSync(memoryDir)) {
    return "No memory files found.";
  }

  const normalizedQuery = query.toLowerCase();
  const matches: Array<{ file: string; score: number; excerpt: string }> = [];

  for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(memoryDir, entry.name);
    const content = await fs.readFile(filePath, "utf-8");
    const lowerContent = content.toLowerCase();
    const nameScore = entry.name.toLowerCase().includes(normalizedQuery) ? 2 : 0;
    const contentIndex = lowerContent.indexOf(normalizedQuery);
    const contentScore = contentIndex >= 0 ? 1 : 0;

    if (nameScore === 0 && contentScore === 0) {
      continue;
    }

    const excerptStart = contentIndex >= 0 ? Math.max(0, contentIndex - 120) : 0;
    const excerpt = content.slice(excerptStart, excerptStart + 400).trim();

    matches.push({
      file: filePath,
      score: nameScore + contentScore,
      excerpt: excerpt || content.slice(0, 400).trim(),
    });
  }

  if (matches.length === 0) {
    return `No memory matches found for "${query}".`;
  }

  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return matches.slice(0, 5).map((match) => {
    return `${match.file}\n${match.excerpt}`;
  }).join("\n\n---\n\n");
}

async function appendAuditEvent(memoryDir: string, event: Record<string, unknown>): Promise<void> {
  const auditDir = path.join(memoryDir, "audit");
  const auditFile = path.join(auditDir, "tool-events.jsonl");
  await fs.mkdir(auditDir, { recursive: true });
  await fs.appendFile(auditFile, `${JSON.stringify(event)}\n`, "utf-8");
}

function summarizeToolResponse(response: { content?: Array<{ type?: string; text?: string }> }): string | null {
  const text = response.content
    ?.filter((entry) => entry.type === "text" && entry.text)
    .map((entry) => entry.text || "")
    .join("\n")
    .trim();

  if (!text) {
    return null;
  }

  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

async function queryAuditLog(memoryDir: string, query: string, limit: number): Promise<string> {
  const auditFile = path.join(memoryDir, "audit", "tool-events.jsonl");
  if (!existsSync(auditFile)) {
    return "No audit events recorded yet.";
  }

  const normalizedQuery = query.toLowerCase();
  const lines = readFileSync(auditFile, "utf-8")
    .split("\n")
    .filter(Boolean);

  const matches = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => JSON.stringify(entry).toLowerCase().includes(normalizedQuery))
    .slice(-limit);

  if (matches.length === 0) {
    return `No audit events found for "${query}".`;
  }

  return matches
    .map((entry) => JSON.stringify(entry, null, 2))
    .join("\n\n---\n\n");
}

function withAudit<TArgs extends Record<string, unknown>>(
  memoryDir: string,
  toolName: string,
  handler: (args: TArgs) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>
) {
  return async (args: TArgs) => {
    const startedAt = new Date().toISOString();

    try {
      const response = await handler(args);
      await appendAuditEvent(memoryDir, {
        timestamp: startedAt,
        tool: toolName,
        args,
        status: response.isError ? "error" : "success",
        summary: summarizeToolResponse(response),
      });
      return response;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await appendAuditEvent(memoryDir, {
        timestamp: startedAt,
        tool: toolName,
        args,
        status: "threw",
        error,
      });
      return createTextResult(`Error: ${error}`, true);
    }
  };
}

async function main() {
  const configPath = process.env.CITIO_CONFIG || "citio.yaml";
  const workspacePath = process.env.CITIO_WORKSPACE || "/workspace";
  const memoryDir = process.env.CITIO_MEMORY || "/memory";

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

  server.tool(
    "investigate_codebase",
    "Search the codebase for files, functions, or patterns related to a query",
    { query: z.string().describe("What to search for") },
    withAudit(memoryDir, "investigate_codebase", async ({ query }) => {
      try {
        const result = runFile(
          "grep",
          ["-rn", "-l", ...SEARCH_INCLUDES, query, "."],
          { cwd: workspacePath, timeout: 30000 }
        );

        const files = result.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20);
        return createTextResult(
          files.length > 0
            ? `Files matching "${query}":\n${files.join("\n")}`
            : `No matches found for "${query}".`
        );
      } catch (err) {
        const message = extractExecError(err);
        if (message.includes("No such file or directory") || message.includes("status 1")) {
          return createTextResult(`No matches found for "${query}".`);
        }
        return createTextResult(`Error searching codebase: ${message}`, true);
      }
    })
  );

  server.tool(
    "read_file",
    "Read file contents from the workspace",
    { path: z.string().describe("Relative path from workspace root") },
    withAudit(memoryDir, "read_file", async ({ path: filePath }) => {
      try {
        const fullPath = resolveUnderRoot(workspacePath, filePath);
        const content = await fs.readFile(fullPath, "utf-8");
        return createTextResult(content);
      } catch (err) {
        return createTextResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })
  );

  server.tool(
    "write_file",
    "Write content to a file (creates or overwrites)",
    { path: z.string(), content: z.string() },
    withAudit(memoryDir, "write_file", async ({ path: filePath, content: fileContent }) => {
      try {
        const fullPath = resolveUnderRoot(workspacePath, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, fileContent, "utf-8");
        return createTextResult(`Written ${filePath}`);
      } catch (err) {
        return createTextResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })
  );

  server.tool(
    "create_branch",
    "Create a git branch with an isolated worktree",
    { repo: z.string(), branch_name: z.string() },
    withAudit(memoryDir, "create_branch", async ({ repo, branch_name }) => {
      try {
        validateBranchName(branch_name);
        const repoPath = resolveUnderRoot(workspacePath, repo);
        const worktreePath = resolveUnderRoot(workspacePath, `${repo}-wt-${branch_name}`);
        runFile("git", ["worktree", "add", worktreePath, "-b", branch_name], {
          cwd: repoPath,
          timeout: 30000,
        });
        return createTextResult(`Branch "${branch_name}" created at ${worktreePath}`);
      } catch (err) {
        return createTextResult(`Error: ${extractExecError(err)}`, true);
      }
    })
  );

  server.tool(
    "create_pr",
    "Push branch and create a GitHub pull request",
    { repo: z.string(), title: z.string(), body: z.string(), branch: z.string(), base: z.string().default("main") },
    withAudit(memoryDir, "create_pr", async ({ repo, title, body, branch, base }) => {
      try {
        validateBranchName(branch);
        const repoPath = resolveUnderRoot(workspacePath, repo);
        runFile("git", ["push", "origin", branch], { cwd: repoPath, timeout: 60000 });
        const result = runFile(
          "gh",
          ["pr", "create", "--title", title, "--body", body, "--head", branch, "--base", base],
          { cwd: repoPath, timeout: 30000 }
        );
        return createTextResult(`PR created: ${result.trim()}`);
      } catch (err) {
        return createTextResult(`Error: ${extractExecError(err)}`, true);
      }
    })
  );

  server.tool(
    "run_command",
    "Run an allowlisted command in the workspace",
    { command: z.string(), cwd: z.string().optional() },
    withAudit(memoryDir, "run_command", async ({ command, cwd }) => {
      const parts = command.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      if (!cmd || COMMAND_BLOCKLIST.has(cmd)) {
        return createTextResult(`Command "${cmd}" is blocked.`, true);
      }
      if (!COMMAND_ALLOWLIST.has(cmd)) {
        return createTextResult(`Command "${cmd}" not in allowlist. Allowed: ${[...COMMAND_ALLOWLIST].join(", ")}`, true);
      }
      if (/[;|&`$(){}]/.test(command)) {
        return createTextResult("Error: shell metacharacters not allowed. Run one command at a time.", true);
      }

      try {
        const workDir = resolveUnderRoot(workspacePath, cwd);
        const result = runFile(cmd, args, {
          cwd: workDir,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return createTextResult(result || "(no output)");
      } catch (err) {
        return createTextResult(`Failed:\n${extractExecError(err)}`, true);
      }
    })
  );

  server.tool(
    "check_ci_status",
    "Check CI/CD status of a pull request",
    { repo: z.string(), pr_number: z.number() },
    withAudit(memoryDir, "check_ci_status", async ({ repo, pr_number }) => {
      try {
        const repoPath = resolveUnderRoot(workspacePath, repo);
        // gh pr checks JSON fields are name/state/bucket/... — "status"/"conclusion"
        // belong to `gh run` and made every call fail with "Unknown JSON field".
        const result = runFile(
          "gh",
          ["pr", "checks", String(pr_number), "--json", "name,state,bucket,link"],
          { cwd: repoPath, timeout: 30000 }
        );
        return createTextResult(`CI for PR #${pr_number}:\n${result}`);
      } catch (err) {
        const detail = extractExecError(err);
        // gh exits non-zero when a PR simply has no checks — that's an answer, not an error.
        if (/no checks reported/i.test(detail)) {
          return createTextResult(`PR #${pr_number} has no CI checks reported (repo may have no CI configured).`);
        }
        return createTextResult(`Error: ${detail}`, true);
      }
    })
  );

  server.tool(
    "save_finding",
    "Save a finding to organizational memory for future reference",
    { topic: z.string(), content: z.string() },
    withAudit(memoryDir, "save_finding", async ({ topic, content: findingContent }) => {
      const slug = topic.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const filePath = path.join(memoryDir, `${slug}.md`);

      try {
        await fs.mkdir(memoryDir, { recursive: true });
        const timestamp = new Date().toISOString();
        const entry = `\n\n## ${timestamp}\n\n${findingContent}\n`;
        if (existsSync(filePath)) {
          await fs.appendFile(filePath, entry, "utf-8");
        } else {
          await fs.writeFile(filePath, `# ${topic}\n${entry}`, "utf-8");
        }
        return createTextResult(`Saved to ${filePath}`);
      } catch (err) {
        return createTextResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })
  );

  server.tool(
    "recall_context",
    "Recall prior findings from organizational memory",
    { query: z.string().describe("What to search for in memory") },
    withAudit(memoryDir, "recall_context", async ({ query }) => {
      try {
        return createTextResult(await findMemoryMatches(memoryDir, query));
      } catch (err) {
        return createTextResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })
  );

  server.tool(
    "query_logs",
    "Query CloudWatch logs for recent events",
    {
      log_group_name: z.string().describe("CloudWatch log group name"),
      filter_pattern: z.string().optional().describe("Optional CloudWatch filter pattern"),
      limit: z.number().int().positive().max(100).default(20),
      region: z.string().optional().describe("AWS region; defaults to AWS_DEFAULT_REGION"),
    },
    withAudit(memoryDir, "query_logs", async ({ log_group_name, filter_pattern, limit, region }) => {
      try {
        const args = [
          "logs",
          "filter-log-events",
          "--log-group-name", log_group_name,
          "--limit", String(limit),
          "--output", "json",
        ];

        if (filter_pattern) {
          args.push("--filter-pattern", filter_pattern);
        }

        if (region || process.env.AWS_DEFAULT_REGION) {
          args.push("--region", region || process.env.AWS_DEFAULT_REGION || "");
        }

        const result = runFile("aws", args, { cwd: workspacePath, timeout: 30000 });
        return createTextResult(result);
      } catch (err) {
        return createTextResult(`Error: ${extractExecError(err)}`, true);
      }
    })
  );

  server.tool(
    "post_update",
    "Record a short progress update for the current task",
    {
      thread_key: z.string().describe("Slack thread key or other stable conversation id"),
      text: z.string().describe("Progress update text"),
    },
    withAudit(memoryDir, "post_update", async ({ thread_key, text }) => {
      const progressDir = path.join(memoryDir, "progress");
      const safeName = thread_key.replace(/[^a-zA-Z0-9._-]/g, "_");
      const progressFile = path.join(progressDir, `${safeName}.jsonl`);

      try {
        await fs.mkdir(progressDir, { recursive: true });
        await fs.appendFile(
          progressFile,
          `${JSON.stringify({ timestamp: new Date().toISOString(), text })}\n`,
          "utf-8"
        );
        return createTextResult(`Progress update recorded for ${thread_key}: ${text}`);
      } catch (err) {
        return createTextResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    })
  );

  server.tool(
    "query_audit_log",
    "Query the recorded MCP tool audit trail",
    {
      query: z.string().describe("Free-text query over audit events"),
      limit: z.number().int().positive().max(100).default(20),
    },
    withAudit(memoryDir, "query_audit_log", async ({ query, limit }) => {
      return createTextResult(await queryAuditLog(memoryDir, query, limit));
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
