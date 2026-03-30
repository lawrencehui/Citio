import "dotenv/config";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { CitioConfigSchema } from "./config/schema.js";
import { WorkspaceManager } from "./core/workspace.js";
import { AgentRunner } from "./core/agent-runner.js";
import { SessionManager } from "./core/session-manager.js";
import { SlackAdapter } from "./adapters/slack.js";
import { resolveEnvVars } from "./utils/env.js";
import { formatCodexAuthHint, getCodexAuthPath, hasCodexCredentials } from "./utils/codex.js";
import { createServer } from "http";

async function main(): Promise<void> {
  const configPath = process.env.CITIO_CONFIG || "citio.yaml";

  let rawConfig: unknown;
  try {
    let raw: string;
    if (process.env.CITIO_CONFIG_B64) {
      // Config passed as base64 env var (for ECS without volume mounts)
      raw = Buffer.from(process.env.CITIO_CONFIG_B64, "base64").toString("utf-8");
    } else {
      raw = readFileSync(configPath, "utf-8");
    }
    rawConfig = resolveEnvVars(parse(raw));
  } catch (err) {
    console.error(`Failed to read config at ${configPath}:`, err);
    process.exit(1);
  }

  const config = CitioConfigSchema.parse(rawConfig);

  const workspacePath = process.env.CITIO_WORKSPACE || "/workspace";

  console.log(
    JSON.stringify({
      type: "startup",
      name: config.name,
      provider: config.engine.default_provider,
      channel: config.slack.channel_id,
      workspace: workspacePath,
      repos: config.workspace.repos.length,
      skills: config.skills.installed.length,
    })
  );

  // Refresh Codex tokens on startup (id_token expires every hour)
  if (config.engine.default_provider === "codex") {
    const fs = await import("fs");
    const home = process.env.HOME || "/home/citio";
    const authPath = getCodexAuthPath(home);
    console.log(JSON.stringify({
      type: "codex_auth_check",
      home,
      authPath,
      hasAuthFile: fs.existsSync(authPath),
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    }));

    if (!hasCodexCredentials()) {
      console.log(JSON.stringify({
        type: "codex_auth_missing",
        message: formatCodexAuthHint(home),
      }));
    }

    try {
      const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      const refreshToken = authData?.tokens?.refresh_token;
      if (refreshToken) {
        console.log(JSON.stringify({ type: "token_refresh", status: "refreshing" }));
        const { execSync: ex } = await import("child_process");
        const resp = ex(
          `curl -s -X POST "https://auth.openai.com/oauth/token" -H "Content-Type: application/json" -d '{"grant_type":"refresh_token","refresh_token":"${refreshToken}","client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}'`,
          { encoding: "utf-8", timeout: 15000 }
        );
        const fresh = JSON.parse(resp);
        if (fresh.id_token && fresh.access_token) {
          authData.tokens.id_token = fresh.id_token;
          authData.tokens.access_token = fresh.access_token;
          if (fresh.refresh_token) authData.tokens.refresh_token = fresh.refresh_token;
          fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
          console.log(JSON.stringify({ type: "token_refresh", status: "success" }));
        } else {
          console.log(JSON.stringify({ type: "token_refresh", status: "failed", error: JSON.stringify(fresh) }));
        }
      }
    } catch (err) {
      console.log(JSON.stringify({ type: "token_refresh", status: "error", error: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (config.engine.default_provider === "claude" && !process.env.ANTHROPIC_API_KEY) {
    console.log(JSON.stringify({
      type: "claude_auth_mode",
      message: process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? "Claude will run without --bare using CLAUDE_CODE_OAUTH_TOKEN."
        : "Claude will run without --bare so it can use non-API-key Claude auth.",
    }));
  }

  // Initialize workspace
  const workspace = new WorkspaceManager(config, workspacePath);
  await workspace.initialize();

  // Initialize agent runner (long-running MCP server for Codex, or -p for Claude)
  const agentRunner = new AgentRunner(config, workspacePath);
  await agentRunner.start();
  const sessionManager = new SessionManager(
    config.engine.default_provider,
    process.env.CITIO_MEMORY || "/memory"
  );

  // Health check server
  const healthServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          agentRunning: agentRunner.isRunning,
          queueLength: agentRunner.queueLength,
          provider: config.engine.default_provider,
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(3001, () => {
    console.log(JSON.stringify({ type: "health_check", port: 3001 }));
  });

  // Start Slack adapter
  const slack = new SlackAdapter(config, agentRunner, sessionManager);
  await slack.start();

  console.log(JSON.stringify({ type: "ready" }));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ type: "shutdown", signal }));
    await Promise.race([slack.stop(), new Promise((r) => setTimeout(r, 10000))]);
    healthServer.close();
    console.log(JSON.stringify({ type: "shutdown_complete" }));
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
