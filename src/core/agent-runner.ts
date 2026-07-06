import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import type { CitioConfig } from "../config/schema.js";
import { ensureCodexMcpConfigured } from "./provider-config.js";
import { formatCodexAuthHint, isLikelyCodexAuthError } from "../utils/codex.js";
import { getTaskRoleEnv, pickDefinedEnv } from "../utils/runtime-env.js";

interface QueuedTask {
  prompt: string;
  threadKey: string;
  sessionId?: string | null;
  onProgress?: (text: string) => void;
  onSessionEstablished?: (sessionId: string) => void;
  onComplete: (output: string) => void;
  onError: (error: Error) => void;
}

function formatToolArgs(args: unknown): string {
  if (args == null) return "";
  try {
    const json = typeof args === "string" ? args : JSON.stringify(args);
    if (!json || json === "{}" || json === "null") return "";
    return ` · ${json.length > 160 ? json.slice(0, 160) + "…" : json}`;
  } catch {
    return "";
  }
}

function appendDedupedText(current: string, next: string): string {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (current === next || current.endsWith(next)) {
    return current;
  }

  if (next.startsWith(current)) {
    return next;
  }

  return `${current}${next}`;
}

export class AgentRunner {
  private config: CitioConfig;
  private queue: QueuedTask[] = [];
  private activeCount = 0;
  private workspacePath: string;
  private mcpConfigPath: string;

  constructor(config: CitioConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
    this.mcpConfigPath = "/tmp/citio/mcp-config.json";
    this.writeMcpConfig();
  }

  private writeMcpConfig(): void {
    mkdirSync("/tmp/citio", { recursive: true });

    const distEntry = path.resolve(process.cwd(), "dist/core/mcp-entry.js");
    const srcEntry = path.resolve(process.cwd(), "src/core/mcp-entry.ts");
    const useTsEntry = !existsSync(distEntry);

    const mcpConfig = {
      mcpServers: {
        citio: {
          command: useTsEntry ? "npx" : "node",
          args: useTsEntry ? ["tsx", srcEntry] : [distEntry],
          env: {
            CITIO_CONFIG: process.env.CITIO_CONFIG || "citio.yaml",
            CITIO_CONFIG_B64: process.env.CITIO_CONFIG_B64 || "",
            CITIO_WORKSPACE: this.workspacePath,
            CITIO_MEMORY: process.env.CITIO_MEMORY || "/memory",
            HOME: process.env.HOME || "/home/citio",
            PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            GH_TOKEN: process.env.GH_TOKEN || "",
            AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "",
            ...getTaskRoleEnv(),
          },
        },
      },
    };

    writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig));
    console.log(JSON.stringify({ type: "mcp_config_written", path: this.mcpConfigPath }));
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.activeCount > 0;
  }

  get isSaturated(): boolean {
    return this.activeCount >= 1;
  }

  async start(): Promise<void> {
    if (this.config.engine.default_provider === "codex") {
      ensureCodexMcpConfigured(this.workspacePath);
      console.log(JSON.stringify({ type: "codex_mcp_configured" }));
    }

    console.log(JSON.stringify({ type: "agent_runner_ready", provider: this.config.engine.default_provider }));
  }

  async submit(task: QueuedTask): Promise<void> {
    this.queue.push(task);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    // Citio hosts a single long-lived provider session per container, so
    // only one task can safely run at a time regardless of Slack thread.
    while (this.activeCount < 1) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }

      this.activeCount += 1;

      void this.runTask(task)
        .catch((err) => {
          task.onError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.activeCount -= 1;
          void this.processQueue();
        });
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    if (this.config.engine.default_provider === "codex") {
      return this.runCodexTask(task);
    }

    return this.runClaudeTask(task);
  }

  private async runClaudeTask(task: QueuedTask): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = (sessionId: string | null | undefined, allowResumeFallback: boolean): void => {
        const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
        const args = [
          "-p", task.prompt,
          "--output-format", "stream-json",
          "--dangerously-skip-permissions",
          "--model", model,
          "--verbose",
          "--mcp-config", this.mcpConfigPath,
        ];

        if (sessionId) {
          args.push("--resume", sessionId);
        }

        console.log(JSON.stringify({
          type: "agent_spawn",
          provider: "claude",
          model,
          prompt_preview: task.prompt.slice(0, 100),
          queue_remaining: this.queue.length,
          resume: Boolean(sessionId),
        }));

        const child = spawn("claude", args, {
          cwd: this.workspacePath,
          stdio: ["pipe", "pipe", "pipe"],
          env: this.buildClaudeEnv(),
        });

        let finalResult = "";
        let lineBuffer = "";
        let sawClaudeTextDelta = false;
        let stderrOutput = "";

        child.stdout?.on("data", (data: Buffer) => {
          lineBuffer += data.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              const sid = (event as Record<string, unknown>).session_id as string | undefined;
              if (sid && !sessionId && task.onSessionEstablished) {
                task.onSessionEstablished(sid);
              }
              this.handleStreamEvent(event, task, {
                appendResult: (text) => {
                  finalResult = appendDedupedText(finalResult, text);
                },
                sawTextDelta: () => {
                  sawClaudeTextDelta = true;
                },
                hasTextDelta: () => sawClaudeTextDelta,
              });
            } catch {
              finalResult = appendDedupedText(finalResult, line);
              task.onProgress?.(line);
            }
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          stderrOutput += text;
          if (!text.includes("no stdin data")) {
            console.log(JSON.stringify({ type: "agent_stderr", data: text.slice(0, 500) }));
            const match = text.match(/session[_ ]id[:\s]+([0-9a-f-]{36})/i);
            if (match && !sessionId && task.onSessionEstablished) {
              task.onSessionEstablished(match[1]);
            }
          }
        });

        child.on("exit", (code) => {
          if (lineBuffer.trim()) {
            try {
              const event = JSON.parse(lineBuffer);
              this.handleStreamEvent(event, task, {
                appendResult: (text) => {
                  finalResult = appendDedupedText(finalResult, text);
                },
                sawTextDelta: () => {
                  sawClaudeTextDelta = true;
                },
                hasTextDelta: () => sawClaudeTextDelta,
              });
            } catch {
              finalResult = appendDedupedText(finalResult, lineBuffer);
            }
          }

          console.log(JSON.stringify({
            type: "agent_exit",
            exit_code: code,
            output_length: finalResult.length,
          }));

          if (sessionId && allowResumeFallback && finalResult.length === 0 && code !== 0) {
            console.log(JSON.stringify({
              type: "agent_resume_failed_retrying_fresh",
              provider: "claude",
            }));
            attempt(null, false);
            return;
          }

          if (finalResult.length > 0 || code === 0) {
            task.onComplete(finalResult);
          } else {
            task.onError(new Error(this.humanizeClaudeError(code, stderrOutput, Boolean(sessionId))));
          }
          resolve();
        });

        child.on("error", (err) => {
          console.log(JSON.stringify({ type: "agent_error", error: err.message }));
          if (sessionId && allowResumeFallback) {
            console.log(JSON.stringify({
              type: "agent_resume_failed_retrying_fresh",
              provider: "claude",
              error: err.message,
            }));
            attempt(null, false);
            return;
          }
          task.onError(err);
          resolve();
        });

        const timeoutMs = this.config.engine.max_session_duration_minutes * 60 * 1000;
        const timer = setTimeout(() => {
          if (child.exitCode === null) {
            console.log(JSON.stringify({ type: "agent_timeout", timeout_ms: timeoutMs }));
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child.exitCode === null) try { child.kill("SIGKILL"); } catch {}
            }, 10000);
          }
        }, timeoutMs);

        child.on("exit", () => clearTimeout(timer));
      };

      attempt(task.sessionId, true);
    });
  }

  private async runCodexTask(task: QueuedTask): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = (sessionId: string | null | undefined, allowResumeFallback: boolean): void => {
        const model = process.env.CODEX_MODEL;
        // Responsiveness: default to low reasoning effort — an ops/status answer
        // shouldn't think for 30s per tool turn. Override with CODEX_REASONING_EFFORT
        // (low|medium|high) for deployments doing heavier engineering work.
        const reasoningEffort = process.env.CODEX_REASONING_EFFORT || "low";
        const args = sessionId
          ? [
              "exec",
              "resume",
              "--json",
              "--dangerously-bypass-approvals-and-sandbox",
              sessionId,
            ]
          : [
              "exec",
              "--json",
              "--skip-git-repo-check",
              "--dangerously-bypass-approvals-and-sandbox",
              "-C", this.workspacePath,
            ];

        if (model) {
          args.push("--model", model);
        }
        args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);

        args.push(task.prompt);

        console.log(JSON.stringify({
          type: "agent_spawn",
          provider: "codex",
          model: model || "default",
          prompt_preview: task.prompt.slice(0, 100),
          queue_remaining: this.queue.length,
          resume: Boolean(sessionId),
        }));

        const child = spawn("codex", args, {
          cwd: this.workspacePath,
          stdio: ["pipe", "pipe", "pipe"],
          env: this.buildCodexEnv(),
        });

        // The prompt is passed as an argument; `codex exec` still watches stdin and
        // prints "Reading additional input from stdin..." and blocks until it is closed.
        // Close it immediately so the run isn't stuck waiting for input that never comes.
        child.stdin?.end();

        let finalResult = "";
        let stderrOutput = "";
        let lineBuffer = "";

        child.stdout?.on("data", (data: Buffer) => {
          lineBuffer += data.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              this.handleCodexEvent(event, task, (text) => { finalResult += text; });
            } catch {
              finalResult += line;
              task.onProgress?.(line);
            }
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          stderrOutput += text;
          console.log(JSON.stringify({ type: "agent_stderr", provider: "codex", data: text.slice(0, 500) }));
        });

        child.on("exit", (code) => {
          if (lineBuffer.trim()) {
            try {
              const event = JSON.parse(lineBuffer) as Record<string, unknown>;
              this.handleCodexEvent(event, task, (text) => { finalResult += text; });
            } catch {
              finalResult += lineBuffer;
            }
          }

          console.log(JSON.stringify({
            type: "agent_exit",
            provider: "codex",
            exit_code: code,
            output_length: finalResult.length,
          }));

          if (sessionId && allowResumeFallback && finalResult.length === 0 && code !== 0) {
            console.log(JSON.stringify({
              type: "agent_resume_failed_retrying_fresh",
              provider: "codex",
            }));
            attempt(null, false);
            return;
          }

          if (finalResult.length > 0 || code === 0) {
            task.onComplete(finalResult);
          } else {
            task.onError(new Error(this.humanizeCodexError(code, stderrOutput)));
          }
          resolve();
        });

        child.on("error", (err) => {
          console.log(JSON.stringify({ type: "agent_error", provider: "codex", error: err.message }));
          if (sessionId && allowResumeFallback) {
            console.log(JSON.stringify({
              type: "agent_resume_failed_retrying_fresh",
              provider: "codex",
              error: err.message,
            }));
            attempt(null, false);
            return;
          }
          task.onError(err);
          resolve();
        });

        const timeoutMs = this.config.engine.max_session_duration_minutes * 60 * 1000;
        const timer = setTimeout(() => {
          if (child.exitCode === null) {
            console.log(JSON.stringify({ type: "agent_timeout", provider: "codex", timeout_ms: timeoutMs }));
            child.kill("SIGTERM");
            setTimeout(() => {
              if (child.exitCode === null) try { child.kill("SIGKILL"); } catch {}
            }, 10000);
          }
        }, timeoutMs);

        child.on("exit", () => clearTimeout(timer));
      };

      attempt(task.sessionId, true);
    });
  }

  private handleStreamEvent(
    event: Record<string, unknown>,
    task: QueuedTask,
    state: {
      appendResult: (text: string) => void;
      sawTextDelta: () => void;
      hasTextDelta: () => boolean;
    }
  ): void {
    const type = event.type as string;

    if (type === "result") {
      // Final result
      const result = event.result as string;
      if (result && !state.hasTextDelta()) {
        state.appendResult(result);
      }
    } else if (type === "assistant" && event.message) {
      // Assistant message with content blocks. Text is typically streamed again via
      // content_block_delta events, so only surface tool usage here.
      const msg = event.message as { content?: Array<{ type: string; name?: string }> };
      for (const block of msg.content || []) {
        if (block.type === "tool_use" && block.name) {
          const blockInput = (block as { input?: unknown }).input;
          if (task.onProgress) task.onProgress(`Using tool: ${block.name}${formatToolArgs(blockInput)}`);
        }
      }
    } else if (type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string };
      if (delta?.type === "text_delta" && delta.text) {
        state.sawTextDelta();
        state.appendResult(delta.text);
      }
    } else if (type === "stream_event") {
      // Nested stream event
      const inner = event.event as Record<string, unknown> | undefined;
      if (inner) this.handleStreamEvent(inner, task, state);
    }
  }

  private handleCodexEvent(
    event: Record<string, unknown>,
    task: QueuedTask,
    appendResult: (text: string) => void
  ): void {
    const type = event.type as string | undefined;

    if (type === "item.started") {
      const item = event.item as { type?: string; server?: string; tool?: string } | undefined;
      if (item?.type === "mcp_tool_call" && item.server && item.tool && task.onProgress) {
        const rawArgs = (item as { arguments?: unknown }).arguments;
        task.onProgress(`Using MCP tool ${item.server}.${item.tool}${formatToolArgs(rawArgs)}`);
      }
      return;
    }

    if (type === "item.completed") {
      const item = event.item as {
        type?: string;
        text?: string;
        server?: string;
        tool?: string;
        error?: string | null;
      } | undefined;

      if (item?.type === "agent_message" && item.text) {
        appendResult(item.text);
      } else if (item?.type === "mcp_tool_call" && item.server && item.tool && task.onProgress) {
        const resultText = this.extractCodexToolResultText(event);
        task.onProgress(item.error
          ? `MCP tool ${item.server}.${item.tool} failed: ${item.error}`
          : resultText || `MCP tool ${item.server}.${item.tool} completed`);
      }
      return;
    }

    if (type === "thread.started") {
      const threadId = event.thread_id as string | undefined;
      if (threadId) {
        task.onSessionEstablished?.(threadId);
        console.log(JSON.stringify({ type: "codex_thread_started", thread_id: threadId }));
      }
    }
  }

  private humanizeCodexError(code: number | null, stderrOutput: string): string {
    const stderr = stderrOutput.trim();

    if (isLikelyCodexAuthError(stderr)) {
      return `${formatCodexAuthHint()}\n${stderr}`;
    }

    if (stderr) {
      return `Codex exited with code ${code}: ${stderr}`;
    }

    return `Codex exited with code ${code}`;
  }

  private humanizeClaudeError(code: number | null, stderrOutput: string, usedResume: boolean): string {
    const stderr = stderrOutput.trim();

    if (stderr) {
      const prefix = usedResume
        ? "Claude could not resume the saved session and the follow-up attempt failed"
        : `Claude exited with code ${code}`;
      return `${prefix}: ${stderr}`;
    }

    return usedResume
      ? "Claude could not resume the saved session and the follow-up attempt failed."
      : `Claude exited with code ${code}`;
  }

  private buildClaudeEnv(): NodeJS.ProcessEnv {
    return {
      HOME: process.env.HOME || "/home/citio",
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      NODE_ENV: process.env.NODE_ENV || "production",
      TERM: process.env.TERM || "xterm-256color",
      TMPDIR: process.env.TMPDIR,
      ...pickDefinedEnv(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
      ...getTaskRoleEnv(),
    };
  }

  private buildCodexEnv(): NodeJS.ProcessEnv {
    return {
      HOME: process.env.HOME || "/home/citio",
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      NODE_ENV: process.env.NODE_ENV || "production",
      TERM: process.env.TERM || "xterm-256color",
      TMPDIR: process.env.TMPDIR,
      ...pickDefinedEnv(["OPENAI_API_KEY", "CODEX_MODEL"]),
      ...getTaskRoleEnv(),
    };
  }

  private extractCodexToolResultText(event: Record<string, unknown>): string | null {
    const item = event.item as {
      result?: { content?: Array<{ type?: string; text?: string }> };
      tool?: string;
    } | undefined;

    if (item?.tool !== "post_update") {
      return null;
    }

    const blocks = item.result?.content;
    if (!blocks || blocks.length === 0) {
      return null;
    }

    const text = blocks
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text?.trim() || "")
      .filter(Boolean)
      .join("\n");

    return text || null;
  }

  async shutdown(): Promise<void> {
    for (const task of this.queue) {
      task.onError(new Error("Agent shutting down"));
    }
    this.queue = [];
  }
}
