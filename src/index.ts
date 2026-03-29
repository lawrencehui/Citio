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

  // Initialize workspace
  const workspace = new WorkspaceManager(config, workspacePath);
  await workspace.initialize();

  // Initialize agent runner (single queue, one process at a time, session resume)
  const agentRunner = new AgentRunner(config, workspacePath);

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
