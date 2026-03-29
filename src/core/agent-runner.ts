import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CitioConfig } from "../config/schema.js";

interface QueuedTask {
  prompt: string;
  threadId: string | null; // null = new conversation, string = continue
  onProgress?: (chunk: string) => void;
  onComplete: (output: string, threadId: string) => void;
  onError: (error: Error) => void;
}

export class AgentRunner {
  private config: CitioConfig;
  private queue: QueuedTask[] = [];
  private running = false;
  private workspacePath: string;
  private mcpClient: Client | null = null;
  private mcpProcess: ChildProcess | null = null;
  private mcpConfigPath: string = "";
  private threadMap = new Map<string, string>(); // slack_thread_ts → codex_thread_id

  constructor(config: CitioConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getThreadId(slackThreadTs: string): string | null {
    return this.threadMap.get(slackThreadTs) || null;
  }

  async start(): Promise<void> {
    const provider = this.config.engine.default_provider;

    if (provider === "codex") {
      await this.startCodexMcpServer();
    } else {
      await this.startClaudeMcpServer();
    }
  }

  private async startCodexMcpServer(): Promise<void> {
    const transport = new StdioClientTransport({
      command: "codex",
      args: [
        "mcp-server",
        "-c", `sandbox="danger-full-access"`,
      ],
      env: {
        ...process.env,
        HOME: process.env.HOME || "/home/citio",
      },
      cwd: this.workspacePath,
    });

    this.mcpClient = new Client({
      name: "citio",
      version: "0.1.0",
    });

    await this.mcpClient.connect(transport);
    console.log(JSON.stringify({ type: "codex_mcp_server_started" }));
  }

  private async startClaudeMcpServer(): Promise<void> {
    // Claude Code uses --mcp-config to connect to our MCP tools server
    // Generate MCP config that points to our mcp-entry.ts
    this.generateMcpConfig();
    console.log(JSON.stringify({ type: "claude_mcp_configured", config: this.mcpConfigPath }));
  }

  private generateMcpConfig(): void {
    const distEntry = path.resolve(process.cwd(), "dist/core/mcp-entry.js");
    const srcEntry = path.resolve(process.cwd(), "src/core/mcp-entry.ts");
    const useTs = !existsSync(distEntry);
    const mcpCommand = useTs ? "npx" : "node";
    const mcpArgs = useTs ? ["tsx", srcEntry] : [distEntry];

    const configDir = "/tmp/citio";
    mkdirSync(configDir, { recursive: true });
    this.mcpConfigPath = `${configDir}/mcp-config.json`;

    const mcpConfig = {
      mcpServers: {
        citio: {
          command: mcpCommand,
          args: mcpArgs,
          env: {
            CITIO_CONFIG: process.env.CITIO_CONFIG || "citio.yaml",
            CITIO_WORKSPACE: this.workspacePath,
            CITIO_MEMORY: process.env.CITIO_MEMORY || "/memory",
            GH_TOKEN: process.env.GH_TOKEN || "",
            AWS_PROFILE: process.env.AWS_PROFILE || "",
            AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "",
            HOME: process.env.HOME || "",
            PATH: process.env.PATH || "",
          },
        },
      },
    };

    writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  }

  async submit(task: QueuedTask): Promise<void> {
    this.queue.push(task);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.running || this.queue.length === 0) return;

    this.running = true;
    const task = this.queue.shift()!;

    try {
      await this.runTask(task);
    } catch (err) {
      task.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      this.processQueue();
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    const provider = this.config.engine.default_provider;

    if (provider === "codex" && this.mcpClient) {
      await this.runCodexTask(task);
    } else {
      await this.runClaudeTask(task);
    }
  }

  private async runCodexTask(task: QueuedTask): Promise<void> {
    if (!this.mcpClient) throw new Error("Codex MCP server not started");

    console.log(JSON.stringify({
      type: "agent_task",
      provider: "codex",
      threadId: task.threadId,
      queue_remaining: this.queue.length,
      prompt_preview: task.prompt.slice(0, 100),
    }));

    try {
      let result;
      if (task.threadId) {
        // Continue existing conversation
        result = await this.mcpClient.callTool({
          name: "codex-reply",
          arguments: {
            threadId: task.threadId,
            prompt: task.prompt,
          },
        });
      } else {
        // New conversation
        result = await this.mcpClient.callTool({
          name: "codex",
          arguments: {
            prompt: task.prompt,
            cwd: this.workspacePath,
            sandbox: "danger-full-access",
          },
        });
      }

      // Extract content and threadId from result
      const content = result.content as Array<{ type: string; text?: string }>;
      const textContent = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      // Parse threadId from the structured output
      let threadId = task.threadId || "";
      try {
        const parsed = JSON.parse(textContent);
        if (parsed.threadId) threadId = parsed.threadId;
        task.onComplete(parsed.content || textContent, threadId);
      } catch {
        // Plain text response
        task.onComplete(textContent, threadId);
      }

      console.log(JSON.stringify({
        type: "agent_complete",
        threadId,
        output_length: textContent.length,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        type: "agent_error",
        error: err instanceof Error ? err.message : String(err),
      }));
      throw err;
    }
  }

  private async runClaudeTask(task: QueuedTask): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
      const args = [
        "-p", task.prompt,
        "--output-format", "text",
        "--dangerously-skip-permissions",
        "--mcp-config", this.mcpConfigPath,
        "--model", model,
      ];

      const child = spawn("claude", args, {
        cwd: this.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let output = "";

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        if (task.onProgress) task.onProgress(chunk);
      });

      child.stderr?.on("data", (data: Buffer) => {
        console.log(JSON.stringify({
          type: "agent_stderr",
          data: data.toString().slice(0, 500),
        }));
      });

      child.on("exit", (code) => {
        if (code === 0 || output.length > 0) {
          task.onComplete(output, "");
          resolve();
        } else {
          task.onError(new Error(`Agent exited with code ${code}`));
          resolve();
        }
      });

      child.on("error", (err) => {
        task.onError(err);
        resolve();
      });

      // Timeout
      const timeoutMs = this.config.engine.max_session_duration_minutes * 60 * 1000;
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 10000);
        }
      }, timeoutMs);
    });
  }

  async shutdown(): Promise<void> {
    for (const task of this.queue) {
      task.onError(new Error("Agent shutting down"));
    }
    this.queue = [];

    if (this.mcpClient) {
      try { await this.mcpClient.close(); } catch {}
    }
    if (this.mcpProcess) {
      try { this.mcpProcess.kill("SIGTERM"); } catch {}
    }
  }
}
