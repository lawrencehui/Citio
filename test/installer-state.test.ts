import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSavedInstallerState, saveInstallerState } from "../src/utils/installer-state.js";
import type { InstallerSecrets, SecretStore } from "../src/utils/secret-store.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "citio-installer-state-"));
}

function createFakeSecretStore(initialSecrets: InstallerSecrets = {}): SecretStore & { savedSecrets: InstallerSecrets | null } {
  let secrets = { ...initialSecrets };
  return {
    savedSecrets: null,
    async loadInstallerSecrets() {
      return { secrets, backend: "file" as const };
    },
    async saveInstallerSecrets(nextSecrets: InstallerSecrets) {
      secrets = { ...nextSecrets };
      this.savedSecrets = { ...nextSecrets };
      return "file" as const;
    },
  };
}

test("loadSavedInstallerState prefers app-state config and secret store values", async () => {
  const cwd = makeTempDir();
  const statePath = path.join(cwd, "installer-state.yaml");
  const localYamlPath = path.join(cwd, "citio.yaml");
  const localEnvPath = path.join(cwd, ".env");
  const secretStore = createFakeSecretStore({
    slackBotToken: "xoxb-from-store",
    githubToken: "ghp-from-store",
  });

  fs.writeFileSync(statePath, [
    "provider: claude",
    "authMethod: oauth",
    "slackChannelId: CAPPDIR",
    "awsRegion: eu-west-2",
    "repos:",
    "  - url: https://github.com/example/app.git",
    "    branch: main",
  ].join("\n"));

  fs.writeFileSync(localYamlPath, [
    "engine:",
    "  default_provider: codex",
    "  auth_method: api_key",
    "slack:",
    "  channel_id: CLOCAL",
    "workspace:",
    "  repos:",
    "    - url: https://github.com/example/local.git",
    "      branch: develop",
  ].join("\n"));

  fs.writeFileSync(localEnvPath, [
    "SLACK_BOT_TOKEN=xoxb-local",
    "GH_TOKEN=ghp-local",
  ].join("\n"));

  const loaded = await loadSavedInstallerState(cwd, {
    statePath,
    localYamlPath,
    localEnvPath,
    secretStore,
  });

  assert.equal(loaded.provider, "claude");
  assert.equal(loaded.authMethod, "oauth");
  assert.equal(loaded.slackChannelId, "CAPPDIR");
  assert.equal(loaded.repos[0]?.url, "https://github.com/example/app.git");
  assert.equal(loaded.slackBotToken, "xoxb-from-store");
  assert.equal(loaded.githubToken, "ghp-from-store");
});

test("saveInstallerState writes non-secret config separately from secrets", async () => {
  const cwd = makeTempDir();
  const statePath = path.join(cwd, "installer-state.yaml");
  const secretStore = createFakeSecretStore();

  const backend = await saveInstallerState(
    {
      provider: "claude",
      authMethod: "oauth",
      slackChannelId: "C1234567890",
      repos: [{ url: "https://github.com/example/repo.git", branch: "main" }],
      rules: ["Always create PRs."],
      skills: ["gstack"],
      awsRegion: "eu-west-2",
      awsProfile: "default",
      enableEfs: true,
    },
    {
      slackBotToken: "xoxb-secret",
      slackAppToken: "xapp-secret",
    },
    {
      statePath,
      secretStore,
    }
  );

  assert.equal(backend, "file");
  const savedYaml = fs.readFileSync(statePath, "utf-8");
  assert.match(savedYaml, /slackChannelId: C1234567890/);
  assert.match(savedYaml, /provider: claude/);
  assert.ok(secretStore.savedSecrets);
  assert.equal(secretStore.savedSecrets?.slackBotToken, "xoxb-secret");
  assert.equal(secretStore.savedSecrets?.slackAppToken, "xapp-secret");
  assert.ok(!savedYaml.includes("xoxb-secret"));
});
