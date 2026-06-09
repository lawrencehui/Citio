import test from "node:test";
import assert from "node:assert/strict";
import { CitioConfigSchema } from "../src/config/schema.js";
import { resolveEnvVars } from "../src/utils/env.js";

test("CitioConfigSchema applies expected runtime defaults", () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_APP_TOKEN = "xapp-test";

  const parsed = CitioConfigSchema.parse(resolveEnvVars({
    slack: {
      bot_token: "${SLACK_BOT_TOKEN}",
      app_token: "${SLACK_APP_TOKEN}",
    },
    engine: {
      providers: {},
    },
    workspace: {
      repos: [
        { url: "https://github.com/example/repo.git" },
      ],
    },
  }));

  assert.equal(parsed.name, "citio");
  assert.equal(parsed.engine.default_provider, "codex");
  assert.equal(parsed.engine.max_concurrent_sessions, 1);
  assert.equal(parsed.skills.directory, "/workspace/.citio/skills/");
  assert.equal(parsed.workspace.repos[0]?.branch, "main");
  assert.equal(parsed.workspace.git.user_name, "Citio");
  assert.equal(parsed.workspace.git.user_email, undefined);
});

test("CitioConfigSchema keeps AWS deploy defaults stable", () => {
  const parsed = CitioConfigSchema.parse({
    slack: {
      bot_token: "xoxb-test",
      app_token: "xapp-test",
    },
    engine: {
      providers: {},
    },
    workspace: {
      repos: [
        { url: "https://github.com/example/repo.git" },
      ],
    },
    deploy: {
      provider: "aws",
      aws: {},
    },
  });

  assert.equal(parsed.deploy?.aws?.task_cpu, 2048);
  assert.equal(parsed.deploy?.aws?.task_memory, 8192);
  assert.equal(parsed.deploy?.aws?.ephemeral_storage_gb, 100);
});
