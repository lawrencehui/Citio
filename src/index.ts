import "dotenv/config";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { CitioConfigSchema } from "./config/schema.js";
import { WorkspaceManager } from "./core/workspace.js";
import { AgentRunner } from "./core/agent-runner.js";
import { SlackAdapter } from "./adapters/slack.js";
import { resolveEnvVars } from "./utils/env.js";
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

  // Ensure agent CLI is authenticated before anything else
  const provider = config.engine.default_provider;
  if (provider === "codex") {
    const { execSync: ex } = await import("child_process");
    // Quick auth check: try a no-op codex command
    try {
      ex("codex exec 'echo ok' --skip-git-repo-check -s danger-full-access --ephemeral", {
        stdio: "pipe", timeout: 30000, cwd: "/tmp",
        env: { ...process.env, HOME: process.env.HOME || "/home/citio" },
      });
      console.log(JSON.stringify({ type: "auth_check", provider: "codex", status: "valid" }));
    } catch {
      // Auth failed or missing. Run device auth (outputs URL + code to stdout/logs).
      console.log(JSON.stringify({ type: "auth_check", provider: "codex", status: "needs_auth" }));
      console.log("========================================");
      console.log("CODEX AUTH REQUIRED — complete device auth below");
      console.log("========================================");
      try {
        ex("codex login --device-auth", { stdio: "inherit", timeout: 300000 });
        console.log(JSON.stringify({ type: "auth_complete", provider: "codex" }));
      } catch (err) {
        console.error("Auth failed. Container will retry on next restart.");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
  }

  // Initialize workspace
  const workspace = new WorkspaceManager(config, workspacePath);
  await workspace.initialize();

  // Initialize agent runner (long-running MCP server for Codex, or -p for Claude)
  const agentRunner = new AgentRunner(config, workspacePath);
  await agentRunner.start();

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
  const slack = new SlackAdapter(config, agentRunner);
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
