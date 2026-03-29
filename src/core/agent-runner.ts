import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import type { CitioConfig } from "../config/schema.js";

interface QueuedTask {
  prompt: string;
  onOutput: (chunk: string) => void;
  onComplete: (output: string, exitCode: number | null) => void;
  onError: (error: Error) => void;
}

export class AgentRunner {
  private config: CitioConfig;
  private queue: QueuedTask[] = [];
  private running = false;
  private currentProcess: ChildProcess | null = null;
  private sessionId: string | null = null; // null until first message creates one
  private workspacePath: string;
  private mcpConfigPath: string;

  constructor(config: CitioConfig, workspacePath: string) {
    this.config = config;
    this.workspacePath = workspacePath;
    this.mcpConfigPath = this.generateMcpConfig();
  }

  private generateMcpConfig(): string {
    // Find the mcp-entry.js path (built or source)
    const distEntry = path.resolve(process.cwd(), "dist/core/mcp-entry.js");
    const srcEntry = path.resolve(process.cwd(), "src/core/mcp-entry.ts");

    const configDir = "/tmp/citio";
    mkdirSync(configDir, { recursive: true });
    const configPath = `${configDir}/mcp-config.json`;

    // Determine if running from dist or via tsx
    const useTs = !existsSync(distEntry);
    const mcpCommand = useTs ? "npx" : "node";
    const mcpArgs = useTs ? ["tsx", srcEntry] : [distEntry];

    const mcpConfig = {
      mcpServers: {
        citio: {
          command: mcpCommand,
          args: mcpArgs,
          env: {
            CITIO_CONFIG: process.env.CITIO_CONFIG || "citio.yaml",
            CITIO_WORKSPACE: this.workspacePath,
            CITIO_MEMORY: process.env.CITIO_MEMORY || "/memory",
            // Pass through credentials ONLY to the MCP server, not the agent
            GH_TOKEN: process.env.GH_TOKEN || "",
            AWS_PROFILE: process.env.AWS_PROFILE || "",
            AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "",
            HOME: process.env.HOME || "",
            PATH: process.env.PATH || "",
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
    return configPath;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
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
      this.currentProcess = null;
      // Process next in queue
      this.processQueue();
    }
  }

  private runTask(task: QueuedTask): Promise<void> {
    return new Promise<void>((resolve) => {
      const provider = this.config.engine.default_provider;

      // Agent gets a STRIPPED env: only what it needs to run, no credentials.
      // Credentials live in the MCP server process, not the agent.
      const env: Record<string, string> = {
        HOME: process.env.HOME || "",
        PATH: process.env.PATH || "",
        USER: process.env.USER || "",
        SHELL: process.env.SHELL || "",
        TERM: process.env.TERM || "xterm-256color",
        LANG: process.env.LANG || "en_US.UTF-8",
      };

      // Agent needs its own API key to call the LLM (Claude/OpenAI), but NOT infra creds
      if (provider === "claude") {
        // Claude Code uses OAuth credentials from ~/.claude/ — pass HOME so it can find them
        const apiKey = this.config.engine.providers.claude?.api_key;
        if (apiKey && !apiKey.startsWith("$")) {
          env.ANTHROPIC_API_KEY = apiKey;
        }
      } else {
        const apiKey = this.config.engine.providers.codex?.api_key;
        if (apiKey && !apiKey.startsWith("$")) {
          env.OPENAI_API_KEY = apiKey;
        }
      }

      const args = this.buildArgs(provider, task.prompt);

      console.log(JSON.stringify({
        type: "agent_spawn",
        provider,
        session_id: this.sessionId,
        queue_remaining: this.queue.length,
        prompt_preview: task.prompt.slice(0, 100),
      }));

      const child = spawn(
        provider === "claude" ? "claude" : "codex",
        args,
        {
          cwd: this.workspacePath,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          env,
        }
      );

      this.currentProcess = child;

      if (!child.pid) {
        task.onError(new Error("Failed to spawn agent process"));
        resolve();
        return;
      }

      let output = "";

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        task.onOutput(chunk);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const stderr = data.toString();
        console.log(JSON.stringify({
          type: "agent_stderr",
          session_id: this.sessionId,
          data: stderr.slice(0, 500),
        }));

        // Capture session ID from Claude Code's first run
        // Claude Code outputs: "Session ID: <uuid>" or similar
        if (!this.sessionId) {
          const uuidMatch = stderr.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (uuidMatch) {
            this.sessionId = uuidMatch[1];
            console.log(JSON.stringify({
              type: "session_captured",
              session_id: this.sessionId,
            }));
          }
        }
      });

      child.on("exit", (code) => {
        console.log(JSON.stringify({
          type: "agent_exit",
          session_id: this.sessionId,
          exit_code: code,
          output_length: output.length,
        }));
        task.onComplete(output, code);
        resolve();
      });

      child.on("error", (err) => {
        console.log(JSON.stringify({
          type: "agent_error",
          session_id: this.sessionId,
          error: err.message,
        }));
        task.onError(err);
        resolve();
      });

      // Wall-clock timeout
      const timeoutMs = this.config.engine.max_session_duration_minutes * 60 * 1000;
      setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          console.log(JSON.stringify({
            type: "agent_timeout",
            session_id: this.sessionId,
            timeout_ms: timeoutMs,
          }));
          try {
            process.kill(-child.pid, "SIGTERM");
            setTimeout(() => {
              try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already dead */ }
            }, 10000);
          } catch {
            try { child.kill("SIGKILL"); } catch { /* already dead */ }
          }
        }
      }, timeoutMs);
    });
  }

  private buildArgs(provider: string, prompt: string): string[] {
    if (provider === "claude") {
      const args = [
        "-p", prompt,
        "--output-format", "text",
        "--dangerously-skip-permissions",
        "--mcp-config", this.mcpConfigPath,
      ];
      // Only resume after first message has created a session
      if (this.sessionId) {
        args.push("--resume", this.sessionId);
      }
      return args;
    } else {
      return ["exec", prompt, "--full-auto"];
    }
  }

  async shutdown(): Promise<void> {
    // Clear the queue
    for (const task of this.queue) {
      task.onError(new Error("Agent shutting down"));
    }
    this.queue = [];

    // Kill current process
    if (this.currentProcess && this.currentProcess.exitCode === null && this.currentProcess.pid) {
      const pid = this.currentProcess.pid;
      try {
        process.kill(-pid, "SIGTERM");
        await new Promise<void>((r) => setTimeout(r, 5000));
        if (this.currentProcess.exitCode === null) {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        try { this.currentProcess.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }
  }
}
