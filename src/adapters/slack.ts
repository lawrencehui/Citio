import { App, Assistant } from "@slack/bolt";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { AgentRunner } from "../core/agent-runner.js";
import { SessionManager } from "../core/session-manager.js";
import type { CitioConfig } from "../config/schema.js";

const CREDENTIAL_PATTERNS = [
  /sk-ant-[a-zA-Z0-9-_]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /xoxb-[0-9]+-[a-zA-Z0-9]+/g,
  /xapp-[0-9]+-[a-zA-Z0-9]+/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
  /AKIA[A-Z0-9]{16}/g,
];

function redactCredentials(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

const MCP_PROGRESS_MESSAGES: Record<string, string> = {
  "mcp__citio__investigate_codebase": "Scanning the codebase...",
  "mcp__citio__read_file": "Reading repository files...",
  "mcp__citio__write_file": "Preparing a code change...",
  "mcp__citio__query_logs": "Querying CloudWatch logs...",
  "mcp__citio__query_audit_log": "Checking the Citio audit trail...",
  "mcp__citio__recall_context": "Recalling prior context...",
  "mcp__citio__run_command": "Running a controlled workspace command...",
  "mcp__citio__check_ci_status": "Checking CI status...",
  "mcp__citio__create_branch": "Preparing a branch...",
  "mcp__citio__create_pr": "Preparing a pull request...",
  "citio.investigate_codebase": "Scanning the codebase...",
  "citio.read_file": "Reading repository files...",
  "citio.write_file": "Preparing a code change...",
  "citio.query_logs": "Querying CloudWatch logs...",
  "citio.query_audit_log": "Checking the Citio audit trail...",
  "citio.recall_context": "Recalling prior context...",
  "citio.run_command": "Running a controlled workspace command...",
  "citio.check_ci_status": "Checking CI status...",
  "citio.create_branch": "Preparing a branch...",
  "citio.create_pr": "Preparing a pull request...",
};

const NATIVE_TOOL_NAMES = new Set(["Agent", "Bash", "Grep", "Glob", "Read", "ToolSearch"]);

function normalizeProgressChunk(chunk: string): string | null {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[Progress] ")) {
    return trimmed;
  }

  if (trimmed.startsWith("Using tool: ")) {
    const toolName = trimmed.slice("Using tool: ".length).trim();
    if (toolName === "mcp__citio__post_update" || NATIVE_TOOL_NAMES.has(toolName)) {
      return null;
    }
    return MCP_PROGRESS_MESSAGES[toolName] || null;
  }

  if (trimmed.startsWith("Using MCP tool ")) {
    const toolName = trimmed.slice("Using MCP tool ".length).trim();
    return MCP_PROGRESS_MESSAGES[toolName] || null;
  }

  if (trimmed.startsWith("MCP tool ")) {
    return null;
  }

  return null;
}

export class SlackAdapter {
  private app: App;
  private config: CitioConfig;
  private agentRunner: AgentRunner;
  private sessionManager: SessionManager;

  constructor(config: CitioConfig, agentRunner: AgentRunner, sessionManager: SessionManager) {
    this.config = config;
    this.agentRunner = agentRunner;
    this.sessionManager = sessionManager;

    this.app = new App({
      token: config.slack.bot_token,
      appToken: config.slack.app_token,
      socketMode: true,
    });

    this.setupAssistant();
  }

  private setupAssistant(): void {
    const assistant = new Assistant({
      threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext }) => {
        console.log(JSON.stringify({
          type: "assistant_thread_started",
          user: event.assistant_thread.user_id,
          channel: event.assistant_thread.context?.channel_id,
        }));

        await saveThreadContext();

        const context = event.assistant_thread.context;

        await say("Hi! I'm Citio, your autonomous CTO agent. Tell me what you need — bug investigation, code fixes, log analysis, or anything else.");

        const prompts: Array<{ title: string; message: string }> = [
          {
            title: "Investigate a bug",
            message: "There's a bug in the login flow — users can't reset their passwords. Can you investigate and fix it?",
          },
          {
            title: "Review recent changes",
            message: "Can you review the latest changes on main and flag any issues?",
          },
          {
            title: "Check deployment status",
            message: "What's the status of our latest deployment? Any errors in the logs?",
          },
        ];

        if (context?.channel_id) {
          prompts.unshift({
            title: "Summarize this channel",
            message: "Can you summarize the recent discussion in this channel?",
          });
        }

        await setSuggestedPrompts({
          title: "Here are some things I can help with:",
          prompts,
        });
      },

      threadContextChanged: async ({ saveThreadContext }) => {
        await saveThreadContext();
      },

      userMessage: async ({ client, message, say, setTitle, setStatus, getThreadContext }) => {
        if (!("text" in message) || !message.text) return;
        if (!("thread_ts" in message) || !message.thread_ts) return;

        const { channel, thread_ts } = message;
        const userId = "user" in message ? message.user : undefined;
        const text = message.text;

        console.log(JSON.stringify({
          type: "user_message",
          user: userId,
          text: text.slice(0, 100),
          channel,
          thread_ts,
        }));

        // DM auth check — only admin_users can DM the bot
        if (
          userId &&
          this.config.slack.admin_users &&
          this.config.slack.admin_users.length > 0 &&
          !this.config.slack.admin_users.includes(userId)
        ) {
          await say("DMs are restricted. Please @mention me in the team channel instead.");
          return;
        }

        try {
          // Set title and status (best-effort — needs assistant:write scope)
          try {
            await setTitle(text.length > 50 ? text.slice(0, 50) + "..." : text);
            await setStatus({
              status: "investigating...",
              loading_messages: [
                "Reading the codebase...",
                "Checking the logs...",
                "Analyzing the issue...",
                "Preparing a fix...",
                "Almost there...",
              ],
            });
          } catch (err) {
            console.log(JSON.stringify({
              type: "assistant_api_warning",
              error: err instanceof Error ? err.message : String(err),
              hint: "Add assistant:write scope in Slack app settings and reinstall",
            }));
          }

          // Get thread context (which channel the user is viewing)
          let contextInfo = "";
          try {
            const threadContext = await getThreadContext();
            contextInfo = threadContext?.channel_id
              ? `The user is currently viewing channel ${threadContext.channel_id}.`
              : "";
          } catch {
            // Context not available
          }

          // Build the prompt with thread context
          const prompt = this.buildPrompt(text, contextInfo, `${channel}:${thread_ts}`);

          // Show queue status if busy
          if (this.agentRunner.isSaturated) {
            await say(`:hourglass: I'm working on another task. Yours is queued (position ${this.agentRunner.queueLength + 1}). I'll get to it shortly.`);
          }

          // Post thinking message
          let thinkingTs: string | undefined;
          try {
            const thinkingMsg = await client.chat.postMessage({
              channel,
              thread_ts,
              text: ":hourglass: Working on it...",
            });
            thinkingTs = thinkingMsg.ts ?? undefined;
          } catch {
            // Continue without
          }

          // Get existing thread mapping (for conversation continuity)
          const threadKey = `${channel}:${thread_ts}`;
          // Only pass sessionId for follow-ups (resume), not first message
          const sessionId = this.getProviderSessionId(threadKey);

          // Submit to the agent
          let dmLastUpdate = Date.now();
          let dmAccOutput = "";
          let dmLastProgressLine = "";
          const stopProgressPolling = this.startProgressPolling(threadKey, (update) => {
            const normalized = normalizeProgressChunk(update);
            if (!normalized || normalized === dmLastProgressLine) {
              return;
            }
            dmLastProgressLine = normalized;
            dmAccOutput += `${dmAccOutput ? "\n" : ""}${normalized}`;
          });

          await this.agentRunner.submit({
            prompt,
            threadKey,
            sessionId,
            onSessionEstablished: (providerSessionId) => {
              this.rememberProviderSession(threadKey, providerSessionId);
            },
            onProgress: (chunk) => {
              const normalized = normalizeProgressChunk(chunk);
              if (!normalized || normalized === dmLastProgressLine) {
                return;
              }
              dmLastProgressLine = normalized;
              dmAccOutput += `${dmAccOutput ? "\n" : ""}${normalized}`;
              const now = Date.now();
              if (thinkingTs && now - dmLastUpdate >= 5000) {
                dmLastUpdate = now;
                const preview = redactCredentials(dmAccOutput).slice(-3800);
                client.chat.update({
                  channel,
                  ts: thinkingTs,
                  text: preview || ":hourglass: Still working...",
                }).catch(() => {});
              }
            },
            onComplete: async (output) => {
              stopProgressPolling();
              const finalOutput = redactCredentials(output);
              try {
                const truncated = finalOutput.length > 3900
                  ? finalOutput.slice(-3900) + "\n\n_(output truncated)_"
                  : finalOutput;

                if (thinkingTs) {
                  await client.chat.update({
                    channel,
                    ts: thinkingTs,
                    text: truncated || "Task completed (no output).",
                  });
                } else {
                  await say(truncated || "Task completed (no output).");
                }
              } catch {
                try { await say(finalOutput.slice(-3900) || "Task completed."); } catch { /* give up */ }
              }
            },
            onError: async (err) => {
              stopProgressPolling();
              await say(`Sorry, something went wrong: ${err.message}`);
            },
          });
        } catch (err) {
          console.error("Error handling message:", err);
          await say(`Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.app.assistant(assistant);

    // Handle @mentions in channels — work directly in the channel thread
    this.app.event("app_mention", async ({ event, client }) => {
      const userId = event.user;
      const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;

      console.log(JSON.stringify({
        type: "app_mention",
        user: userId,
        text: text.slice(0, 100),
        channel,
      }));

      if (!text) return;

      // Auth check — only authorized users can use in channels
      if (
        userId &&
        this.config.slack.authorized_users &&
        this.config.slack.authorized_users.length > 0 &&
        !this.config.slack.authorized_users.includes(userId)
      ) {
        return; // Silent ignore
      }

      // Post thinking message directly in channel (not in thread)
      let thinkingTs: string | undefined;
      try {
        const msg = await client.chat.postMessage({
          channel,
          text: ":hourglass: Working on it...",
        });
        thinkingTs = msg.ts ?? undefined;
      } catch {
        // Continue without
      }

      const threadKey = `${channel}:${threadTs}`;
      const sessionId = this.getProviderSessionId(threadKey);

      const prompt = this.buildPrompt(text, "", threadKey);

      let lastUpdateTime = Date.now();
      let accumulatedOutput = "";
      let lastProgressLine = "";
      const stopProgressPolling = this.startProgressPolling(threadKey, (update) => {
        const normalized = normalizeProgressChunk(update);
        if (!normalized || normalized === lastProgressLine) {
          return;
        }
        lastProgressLine = normalized;
        accumulatedOutput += `${accumulatedOutput ? "\n" : ""}${normalized}`;
      });

      await this.agentRunner.submit({
        prompt,
        threadKey,
        sessionId,
        onSessionEstablished: (providerSessionId) => {
          this.rememberProviderSession(threadKey, providerSessionId);
        },
        onProgress: (chunk) => {
          const normalized = normalizeProgressChunk(chunk);
          if (!normalized || normalized === lastProgressLine) {
            return;
          }
          lastProgressLine = normalized;
          accumulatedOutput += `${accumulatedOutput ? "\n" : ""}${normalized}`;
          const now = Date.now();
          // Update thinking message every 5 seconds with latest output
          if (thinkingTs && now - lastUpdateTime >= 5000) {
            lastUpdateTime = now;
            const preview = redactCredentials(accumulatedOutput).slice(-3800);
            client.chat.update({
              channel,
              ts: thinkingTs,
              text: preview || ":hourglass: Still working...",
            }).catch(() => {});
          }
        },
        onComplete: async (output) => {
          stopProgressPolling();
          const finalOutput = redactCredentials(output);
          try {
            const truncated = finalOutput.length > 3900
              ? finalOutput.slice(-3900) + "\n\n_(output truncated)_"
              : finalOutput;

            if (thinkingTs) {
              await client.chat.update({
                channel,
                ts: thinkingTs,
                text: truncated || "Done (no output).",
              });
            } else {
              await client.chat.postMessage({
                channel,
                text: truncated || "Done (no output).",
              });
            }
          } catch {
            try {
              await client.chat.postMessage({
                channel,
                text: finalOutput.slice(-3900) || "Done.",
              });
            } catch { /* give up */ }
          }
        },
        onError: async (err) => {
          stopProgressPolling();
          await client.chat.postMessage({
            channel,
            text: `Sorry, something went wrong: ${err.message}`,
          });
        },
      });
    });
  }

  private getProviderSessionId(threadKey: string): string | null {
    return this.sessionManager.get(threadKey);
  }

  private rememberProviderSession(threadKey: string, sessionId: string): void {
    this.sessionManager.remember(threadKey, sessionId);
  }

  private buildPrompt(userMessage: string, contextInfo: string, threadKey: string): string {
    const parts = [
      "You are Citio, an autonomous CTO agent. A team member is asking for help.",
      "You should prefer the Citio MCP tools for repository investigation, file edits, pull requests, CI checks, log queries, and controlled command execution.",
      "Use the Citio MCP tools instead of native Bash/Grep/Glob/Read tools whenever a Citio tool can do the job.",
      "For AWS and CloudWatch work, prefer query_logs first and only fall back to Citio run_command when query_logs cannot answer the question.",
      "If you use shell access, keep it to the minimum needed and do not assume direct credential access.",
      "For AWS commands: never use --profile. The ECS task role provides credentials automatically when those commands are available.",
      `If you want to send a structured progress update, call post_update with thread_key=\"${threadKey}\".`,
    ];

    // Team rules from citio.yaml — the user's behaviour guardrails for the agent.
    const teamRules = this.config.workspace?.rules ?? [];
    if (teamRules.length > 0) {
      parts.push(
        "Team rules — follow these on every task:\n" +
        teamRules.map((rule) => `- ${rule}`).join("\n")
      );
    }

    if (contextInfo) {
      parts.push(contextInfo);
    }

    parts.push(`User's message: ${userMessage}`);
    parts.push("Help them with their request. Be concise and actionable.");
    parts.push(`IMPORTANT: Format your response using Slack mrkdwn syntax, NOT markdown.
Slack formatting rules:
- Bold: *bold* (NOT **bold**)
- Italic: _italic_ (NOT *italic*)
- Strikethrough: ~strikethrough~
- Code inline: \`code\`
- Code block: \`\`\`code block\`\`\`
- Bullet lists: use bullet character • or dash - with no extra blank lines between items
- Numbered lists: 1. 2. 3. (no extra blank lines)
- Links: <https://example.com|link text>
- Block quotes: > quoted text
- NO headers (# syntax does not work in Slack)
- NO horizontal rules
- Keep paragraphs short. Use single newlines between sections, not double.`);

    return parts.join("\n\n");
  }

  private startProgressPolling(threadKey: string, onUpdate: (text: string) => void): () => void {
    const memoryDir = process.env.CITIO_MEMORY || "/memory";
    const safeName = threadKey.replace(/[^a-zA-Z0-9._-]/g, "_");
    const progressPath = path.join(memoryDir, "progress", `${safeName}.jsonl`);
    let offset = existsSync(progressPath) ? readFileSync(progressPath, "utf-8").length : 0;
    let stopped = false;

    const poll = () => {
      if (stopped || !existsSync(progressPath)) {
        return;
      }

      try {
        const content = readFileSync(progressPath, "utf-8");
        if (content.length <= offset) {
          return;
        }

        const chunk = content.slice(offset);
        offset = content.length;

        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as { text?: string };
            if (entry.text) {
              onUpdate(`[Progress] ${entry.text}`);
            }
          } catch {
            // Ignore malformed lines from partial writes.
          }
        }
      } catch {
        // Best-effort only.
      }
    };

    const interval = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log(JSON.stringify({
      type: "slack_connected",
      mode: "assistant",
      channel: this.config.slack.channel_id,
    }));
  }

  async stop(): Promise<void> {
    await this.agentRunner.shutdown();
    await this.app.stop();
  }
}
