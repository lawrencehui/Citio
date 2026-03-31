import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import path from "path";
import { parse as parseDotenv } from "dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getInstallerStatePath } from "./app-state.js";
import { loadInstallerSecrets, saveInstallerSecrets, type InstallerSecrets } from "./secret-store.js";

export interface SavedInstallerState {
  provider?: "codex" | "claude";
  authMethod?: "oauth" | "api_key";
  slackBotToken?: string;
  slackAppToken?: string;
  slackChannelId?: string;
  githubToken?: string;
  repos: Array<{ url: string; branch: string }>;
  rules: string[];
  skills: string[];
  awsRegion?: string;
  awsProfile?: string;
  enableEfs?: boolean;
  claudeOauthToken?: string;
  openAiApiKey?: string;
  anthropicApiKey?: string;
  secretBackend: "keychain" | "file";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRepoArray(value: unknown): Array<{ url: string; branch: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const repo = item as { url?: unknown; branch?: unknown };
    const url = asString(repo.url);
    if (!url) {
      return [];
    }

    return [{
      url,
      branch: asString(repo.branch) || "main",
    }];
  });
}

function loadYamlState(filePath: string): Partial<SavedInstallerState> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = parseYaml(readFileSync(filePath, "utf-8")) as Record<string, unknown> | null;
    const slack = parsed?.slack as Record<string, unknown> | undefined;
    const engine = parsed?.engine as Record<string, unknown> | undefined;
    const workspace = parsed?.workspace as Record<string, unknown> | undefined;
    const skills = parsed?.skills as Record<string, unknown> | undefined;
    const deploy = parsed?.deploy as Record<string, unknown> | undefined;
    const aws = deploy?.aws as Record<string, unknown> | undefined;

    return {
      provider: engine?.default_provider === "codex" || engine?.default_provider === "claude"
        ? engine.default_provider
        : undefined,
      authMethod: engine?.auth_method === "oauth" || engine?.auth_method === "api_key"
        ? engine.auth_method
        : undefined,
      slackChannelId: asString(slack?.channel_id),
      repos: asRepoArray(workspace?.repos),
      rules: asStringArray(workspace?.rules),
      skills: asStringArray(skills?.installed),
      awsRegion: asString(aws?.region),
      awsProfile: asString(aws?.profile),
      enableEfs: asBoolean(aws?.enable_efs),
    };
  } catch {
    return {};
  }
}

function loadLocalEnvSecrets(cwd: string): InstallerSecrets {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  try {
    const parsed = parseDotenv(readFileSync(envPath, "utf-8"));
    return {
      slackBotToken: asString(parsed.SLACK_BOT_TOKEN),
      slackAppToken: asString(parsed.SLACK_APP_TOKEN),
      githubToken: asString(parsed.GH_TOKEN),
      claudeOauthToken: asString(parsed.CLAUDE_CODE_OAUTH_TOKEN),
      openAiApiKey: asString(parsed.OPENAI_API_KEY),
      anthropicApiKey: asString(parsed.ANTHROPIC_API_KEY),
    };
  } catch {
    return {};
  }
}

export async function loadSavedInstallerState(cwd: string): Promise<SavedInstallerState> {
  const statePath = getInstallerStatePath();
  const stateFromAppDir = loadYamlState(statePath);
  const localYamlFallback = loadYamlState(path.join(cwd, "citio.yaml"));
  const { secrets, backend } = await loadInstallerSecrets();
  const localEnvFallback = loadLocalEnvSecrets(cwd);

  return {
    provider: stateFromAppDir.provider || localYamlFallback.provider,
    authMethod: stateFromAppDir.authMethod || localYamlFallback.authMethod,
    slackChannelId: stateFromAppDir.slackChannelId || localYamlFallback.slackChannelId,
    repos: stateFromAppDir.repos?.length ? stateFromAppDir.repos : (localYamlFallback.repos || []),
    rules: stateFromAppDir.rules?.length ? stateFromAppDir.rules : (localYamlFallback.rules || []),
    skills: stateFromAppDir.skills?.length ? stateFromAppDir.skills : (localYamlFallback.skills || []),
    awsRegion: stateFromAppDir.awsRegion || localYamlFallback.awsRegion,
    awsProfile: stateFromAppDir.awsProfile || localYamlFallback.awsProfile,
    enableEfs: stateFromAppDir.enableEfs ?? localYamlFallback.enableEfs,
    slackBotToken: secrets.slackBotToken || localEnvFallback.slackBotToken,
    slackAppToken: secrets.slackAppToken || localEnvFallback.slackAppToken,
    githubToken: secrets.githubToken || localEnvFallback.githubToken,
    claudeOauthToken: secrets.claudeOauthToken || localEnvFallback.claudeOauthToken,
    openAiApiKey: secrets.openAiApiKey || localEnvFallback.openAiApiKey,
    anthropicApiKey: secrets.anthropicApiKey || localEnvFallback.anthropicApiKey,
    secretBackend: backend,
  };
}

export async function saveInstallerState(
  state: Omit<SavedInstallerState, "secretBackend" | keyof InstallerSecrets>,
  secrets: InstallerSecrets
): Promise<"keychain" | "file"> {
  const statePath = getInstallerStatePath();
  const yaml = stringifyYaml({
    provider: state.provider,
    authMethod: state.authMethod,
    slackChannelId: state.slackChannelId,
    repos: state.repos,
    rules: state.rules,
    skills: state.skills,
    awsRegion: state.awsRegion,
    awsProfile: state.awsProfile,
    enableEfs: state.enableEfs,
  });

  writeFileSync(statePath, yaml, "utf-8");
  chmodSync(statePath, 0o600);

  return saveInstallerSecrets(secrets);
}
