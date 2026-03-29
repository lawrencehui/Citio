import { App, Assistant } from "@slack/bolt";
import { AgentRunner } from "../core/agent-runner.js";
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

export class SlackAdapter {
  private app: App;
  private config: CitioConfig;
  private agentRunner: AgentRunner;

  constructor(config: CitioConfig, agentRunner: AgentRunner) {
    this.config = config;
    this.agentRunner = agentRunner;

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
          const prompt = this.buildPrompt(text, contextInfo);

          // Show queue status if busy
          if (this.agentRunner.isRunning) {
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
          const existingThreadId = this.agentRunner.getThreadId(thread_ts);

          // Submit to the agent (single queue, Codex MCP server handles the rest)
          await this.agentRunner.submit({
            prompt,
            threadId: existingThreadId,
            onComplete: async (output, codexThreadId) => {
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

      const existingThreadId = this.agentRunner.getThreadId(threadTs);
      const prompt = this.buildPrompt(text, "");

      await this.agentRunner.submit({
        prompt,
        threadId: existingThreadId,
        onComplete: async (output, codexThreadId) => {
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
          await client.chat.postMessage({
            channel,
            text: `Sorry, something went wrong: ${err.message}`,
          });
        },
      });
    });
  }

  private buildPrompt(userMessage: string, contextInfo: string): string {
    const parts = [
      "You are Citio, an autonomous CTO agent. A team member is asking for help.",
    ];

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
