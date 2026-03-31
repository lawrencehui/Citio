import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { getFallbackSecretsPath } from "./app-state.js";

const SERVICE_NAME = "citio";

export interface InstallerSecrets {
  slackBotToken?: string;
  slackAppToken?: string;
  githubToken?: string;
  claudeOauthToken?: string;
  openAiApiKey?: string;
  anthropicApiKey?: string;
}

type SecretKey = keyof InstallerSecrets;

const SECRET_KEYS: SecretKey[] = [
  "slackBotToken",
  "slackAppToken",
  "githubToken",
  "claudeOauthToken",
  "openAiApiKey",
  "anthropicApiKey",
];

const SECRET_ACCOUNT_NAMES: Record<SecretKey, string> = {
  slackBotToken: "slack_bot_token",
  slackAppToken: "slack_app_token",
  githubToken: "github_token",
  claudeOauthToken: "claude_oauth_token",
  openAiApiKey: "openai_api_key",
  anthropicApiKey: "anthropic_api_key",
};

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    const module = await import("keytar");
    return module.default ?? module;
  } catch {
    return null;
  }
}

function loadFallbackSecrets(): InstallerSecrets {
  const secretsPath = getFallbackSecretsPath();
  if (!existsSync(secretsPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(secretsPath, "utf-8")) as InstallerSecrets;
  } catch {
    return {};
  }
}

function persistFallbackSecrets(secrets: InstallerSecrets): void {
  const secretsPath = getFallbackSecretsPath();
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), "utf-8");
  chmodSync(secretsPath, 0o600);
}

export async function loadInstallerSecrets(): Promise<{ secrets: InstallerSecrets; backend: "keychain" | "file" }> {
  const keytar = await loadKeytar();
  if (keytar) {
    const secrets: InstallerSecrets = {};
    for (const key of SECRET_KEYS) {
      const value = await keytar.getPassword(SERVICE_NAME, SECRET_ACCOUNT_NAMES[key]);
      if (value) {
        secrets[key] = value;
      }
    }
    return { secrets, backend: "keychain" };
  }

  return { secrets: loadFallbackSecrets(), backend: "file" };
}

export async function saveInstallerSecrets(secrets: InstallerSecrets): Promise<"keychain" | "file"> {
  const keytar = await loadKeytar();
  if (keytar) {
    for (const key of SECRET_KEYS) {
      const value = secrets[key];
      const account = SECRET_ACCOUNT_NAMES[key];
      if (value) {
        await keytar.setPassword(SERVICE_NAME, account, value);
      } else {
        await keytar.deletePassword(SERVICE_NAME, account);
      }
    }
    return "keychain";
  }

  persistFallbackSecrets(secrets);
  return "file";
}
