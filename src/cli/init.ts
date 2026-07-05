#!/usr/bin/env node
import * as p from "@clack/prompts";
import { execSync, execFileSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import path from "path";
import os from "os";
import { stringify } from "yaml";
import { extractClaudeOauthTokenFromTranscript, normalizeClaudeOauthToken, validateClaudeOauthToken } from "../utils/claude.js";
import { loadSavedInstallerState, saveInstallerState } from "../utils/installer-state.js";
import {
  buildCitioSlackManifest,
  createCitioSlackApp,
  openBrowser,
  validateSlackAppToken,
  validateSlackBotToken,
  validateSlackConfigToken,
} from "../utils/slack-onboarding.js";

interface InitConfig {
  provider: "codex" | "claude";
  authMethod: "oauth" | "api_key";
  providerApiKey: string;
  claudeOauthToken: string;
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  githubToken: string;
  repos: Array<{ url: string; branch: string }>;
  rules: string[];
  skills: string[];
  gitUserEmail: string;
  awsRegion: string;
  awsProfile: string;
  enableEfs: boolean;
}

const SKILL_REGISTRY: Record<string, { url: string; description: string; installMethod: "git" | "npx-skills" | "npx" }> = {
  gstack: {
    url: "https://github.com/garrytan/gstack.git",
    description: "QA, shipping, investigation, deploy, design review",
    installMethod: "git",
  },
  "frontend-design": {
    url: "anthropics/claude-code --skill frontend-design",
    description: "Production-grade UI generation, avoids default design patterns",
    installMethod: "npx-skills",
  },
  "code-reviewer": {
    url: "anthropics/claude-code --skill simplify",
    description: "Code quality review, deduplication, performance checks",
    installMethod: "npx-skills",
  },
  "antigravity-awesome-skills": {
    url: "npx antigravity-awesome-skills --claude",
    description: "1,234+ curated skills: brainstorming, architecture, debugging, API design",
    installMethod: "npx",
  },
};

function runDeployCommand(command: string, errorMessage: string, options: { cwd?: string; timeout?: number; encoding?: BufferEncoding } = {}): string {
  try {
    return execSync(command, {
      stdio: "pipe",
      encoding: options.encoding || "utf-8",
      cwd: options.cwd,
      timeout: options.timeout,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    p.log.error(`${errorMessage}\n${detail}`);
    process.exit(1);
  }
}

function sleep(seconds: number): void {
  execSync(`sleep ${seconds}`, { stdio: "pipe" });
}

function resolveEfsFileSystemId(region: string, profileFlag: string, createdEfsId: string): string {
  if (createdEfsId) {
    return createdEfsId;
  }

  const discovered = runDeployCommand(
    `aws efs describe-file-systems --creation-token citio-memory --region ${region} ${profileFlag} --query 'FileSystems[0].FileSystemId' --output text`,
    "Failed to resolve the Citio EFS filesystem. Re-run the installer with EFS enabled or create the filesystem first."
  ).trim();

  if (!discovered || discovered === "None" || discovered === "null") {
    p.log.error("No Citio EFS filesystem was found for creation token `citio-memory`.");
    process.exit(1);
  }

  return discovered;
}

function checkPrerequisites(): void {
  const missing: string[] = [];

  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch {
    missing.push("docker");
  }

  try {
    execSync("aws --version", { stdio: "pipe" });
  } catch {
    missing.push("aws-cli");
  }

  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    missing.push("git");
  }

  if (missing.length > 0) {
    p.log.error(
      `Missing prerequisites: ${missing.join(", ")}. Please install them first.`
    );
    process.exit(1);
  }
}

async function ensurePortableClaudeAuth(homeDir: string): Promise<string> {
  void homeDir;

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    if (validateClaudeOauthToken(process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
      p.log.success("Verified Claude OAuth token from CLAUDE_CODE_OAUTH_TOKEN.");
      return normalizeClaudeOauthToken(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    }

    p.log.warn("CLAUDE_CODE_OAUTH_TOKEN is set but did not validate. Falling back to local Claude auth checks.");
  }

  p.log.info(
    "Running `claude setup-token` to create a long-lived token for ECS..."
  );

  let extractedToken = "";
  try {
    const transcriptPath = path.join(os.tmpdir(), `citio-claude-setup-token-${Date.now()}.log`);
    execFileSync("script", ["-q", transcriptPath, "claude", "setup-token"], {
      stdio: "inherit",
      timeout: 300000,
    });
    extractedToken = extractClaudeOauthTokenFromTranscript(transcriptPath) || "";
  } catch {
    p.log.error("`claude setup-token` failed. Re-run `citio` later or use API key auth.");
    process.exit(1);
  }

  if (extractedToken && validateClaudeOauthToken(extractedToken)) {
    p.log.success("Captured and verified Claude OAuth token from `claude setup-token`.");
    return extractedToken;
  }

  const token = (await p.text({
    message: "Paste the CLAUDE_CODE_OAUTH_TOKEN that Claude just showed you:",
    placeholder: "sk-ant-oat01-...",
  })) as string;

  if (p.isCancel(token)) process.exit(0);

  const normalizedToken = normalizeClaudeOauthToken(token);

  if (!validateClaudeOauthToken(normalizedToken)) {
    p.log.error(
      "That Claude OAuth token did not validate from a clean environment. Re-run `claude setup-token` and paste the full token exactly."
    );
    process.exit(1);
  }

  p.log.success("Verified portable Claude OAuth token. It will be deployed as CLAUDE_CODE_OAUTH_TOKEN.");
  return normalizedToken;
}

async function reuseOrPromptSecret(options: {
  message: string;
  existingValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}): Promise<string> {
  const value = await p.password({
    message: options.existingValue
      ? `${options.message} (press Enter to keep saved value)`
      : options.message,
    validate: (input) => {
      if (!input && options.existingValue) {
        return undefined;
      }
      return options.validate ? options.validate(input) : undefined;
    },
  });

  if (p.isCancel(value)) process.exit(0);
  if (!value && options.existingValue) {
    return options.existingValue;
  }
  return value;
}

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    }
    if (process.platform === "linux") {
      execSync("xclip -selection clipboard", { input: text, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    }
  } catch {
    // Best-effort only — the manifest is printed either way.
  }
  return false;
}

async function promptSlackTokensManually(savedState: Awaited<ReturnType<typeof loadSavedInstallerState>>): Promise<{ slackBotToken: string; slackAppToken: string }> {
  const manifestJson = JSON.stringify(buildCitioSlackManifest(), null, 2);
  const manifestPath = path.join(process.cwd(), "slack-app-manifest.json");
  writeFileSync(manifestPath, manifestJson + "\n");
  const copied = copyToClipboard(manifestJson);

  p.note(
    "You'll create the Slack app by pasting a ready-made manifest —\n" +
    "no scope-hunting needed. The manifest sets every permission,\n" +
    "event subscription, and Socket Mode for you.",
    "Guided Slack setup (~3 minutes)"
  );

  if (copied) {
    p.log.success(`The app manifest is on your clipboard (also saved to ${manifestPath}).`);
  } else {
    p.log.info(`The app manifest is saved to ${manifestPath} — copy its contents, or copy the block below:`);
    console.log("–––––––––––––––––––––––––––––––––––––––––––––");
    console.log(manifestJson);
    console.log("–––––––––––––––––––––––––––––––––––––––––––––");
  }

  const openedCreate = openBrowser("https://api.slack.com/apps?new_app=1");
  p.note(
    `STEP 1 — Create the app (${openedCreate ? "a browser window just opened" : "open https://api.slack.com/apps?new_app=1"})\n` +
    "  • Choose “From a manifest” → pick your workspace → Next\n" +
    "  • Select the JSON tab, paste the manifest, → Next → Create\n" +
    "\n" +
    "STEP 2 — Install it\n" +
    "  • On the app page: “Install App” (left sidebar) → “Install to Workspace” → Allow\n" +
    "\n" +
    "STEP 3 — Copy the Bot Token (xoxb-…)\n" +
    "  • Left sidebar → “OAuth & Permissions”\n" +
    "  • Copy “Bot User OAuth Token” — it starts with xoxb-\n" +
    "\n" +
    "STEP 4 — Create + copy the App Token (xapp-…)\n" +
    "  • Left sidebar → “Basic Information” → scroll to “App-Level Tokens”\n" +
    "  • “Generate Token and Scopes” → name it citio-socket\n" +
    "  • “Add Scope” → connections:write → Generate\n" +
    "  • Copy the token — it starts with xapp-",
    "Slack app — 4 steps"
  );

  const slackBotToken = await reuseOrPromptSecret({
    message: "Paste the Bot Token (xoxb-…) from OAuth & Permissions:",
    existingValue: savedState.slackBotToken,
    validate: validateSlackBotToken,
  });

  const slackAppToken = await reuseOrPromptSecret({
    message: "Paste the App Token (xapp-…) from Basic Information → App-Level Tokens:",
    existingValue: savedState.slackAppToken,
    validate: validateSlackAppToken,
  });

  return { slackBotToken, slackAppToken };
}

async function collectSlackTokens(savedState: Awaited<ReturnType<typeof loadSavedInstallerState>>): Promise<{ slackBotToken: string; slackAppToken: string }> {
  const hasSavedTokens = Boolean(savedState.slackBotToken && savedState.slackAppToken);

  const setupMode = (await p.select({
    message: "How should Slack be configured?",
    initialValue: hasSavedTokens ? "reuse" : "manual",
    options: [
      ...(hasSavedTokens ? [{
        value: "reuse",
        label: "Reuse saved Slack tokens",
        hint: "Keep the previously saved bot and app tokens",
      }] : []),
      {
        value: "manual",
        label: "Guided setup (recommended)",
        hint: "Paste a ready-made app manifest into Slack — we walk you through every click",
      },
      {
        value: "automatic",
        label: "Automatic app creation",
        hint: "Citio creates the app via the Slack API — needs an app configuration token (xoxe…)",
      },
    ],
  })) as "reuse" | "automatic" | "manual";

  if (p.isCancel(setupMode)) process.exit(0);

  if (setupMode === "reuse") {
    return {
      slackBotToken: savedState.slackBotToken!,
      slackAppToken: savedState.slackAppToken!,
    };
  }

  if (setupMode === "manual") {
    return promptSlackTokensManually(savedState);
  }

  const openedAppsPage = openBrowser("https://api.slack.com/apps");
  p.note(
    "Citio will create the Slack app and configure every scope for you.\n" +
    "It needs a one-time “app configuration token” from Slack:\n" +
    "\n" +
    `  1. ${openedAppsPage ? "In the browser window that just opened" : "Open https://api.slack.com/apps"},\n` +
    "     scroll to the bottom section “Your App Configuration Tokens”\n" +
    "  2. Click “Generate Token” and pick the workspace Citio should join\n" +
    "  3. Copy the ACCESS token — it starts with xoxe-\n" +
    "\n" +
    "(This token only creates the app and expires after 12 hours —\n" +
    "it is not stored. You'll still approve the install and create one\n" +
    "Socket Mode token in the browser afterwards.)",
    "Automatic Slack setup (~2 minutes)"
  );

  const configToken = await reuseOrPromptSecret({
    message: "Paste the app configuration token (xoxe…):",
    validate: validateSlackConfigToken,
  });

  const spinner = p.spinner();
  spinner.start("Creating the Slack app via manifest...");

  let slackApp: Awaited<ReturnType<typeof createCitioSlackApp>>;
  try {
    slackApp = await createCitioSlackApp(configToken, { appName: "Citio" });
  } catch (error) {
    spinner.stop("Slack app creation failed.");
    p.log.error(error instanceof Error ? error.message : String(error));
    const fallback = (await p.confirm({
      message: "Slack app automation failed. Fall back to manual token entry?",
      initialValue: true,
    })) as boolean;
    if (p.isCancel(fallback)) process.exit(0);
    if (!fallback) {
      process.exit(1);
    }
    return promptSlackTokensManually(savedState);
  }

  spinner.stop(`Created Slack app ${slackApp.appId}.`);

  const openedAuthUrl = openBrowser(slackApp.oauthAuthorizeUrl);
  const openedSettingsUrl = openBrowser(slackApp.settingsUrl);

  p.note(
    `STEP 1 — Approve the install${openedAuthUrl ? " (a browser window just opened)" : ""}\n` +
    (openedAuthUrl ? "" : `  • Open ${slackApp.oauthAuthorizeUrl}\n`) +
    "  • Click “Allow” to install the app to your workspace\n" +
    "\n" +
    `STEP 2 — Copy the Bot Token (xoxb-…)\n` +
    `  • In the app settings${openedSettingsUrl ? " window that opened" : ` at ${slackApp.settingsUrl}`}:\n` +
    "  • Left sidebar → “OAuth & Permissions”\n" +
    "  • Copy “Bot User OAuth Token” — it starts with xoxb-\n" +
    "\n" +
    "STEP 3 — Create + copy the App Token (xapp-…)\n" +
    "  • Left sidebar → “Basic Information” → scroll to “App-Level Tokens”\n" +
    "  • “Generate Token and Scopes” → name it citio-socket\n" +
    "  • “Add Scope” → connections:write → Generate\n" +
    "  • Copy the token — it starts with xapp-",
    "Finish in the browser — 3 steps"
  );

  const slackBotToken = await reuseOrPromptSecret({
    message: "Paste the Bot Token (xoxb-…) from OAuth & Permissions:",
    existingValue: savedState.slackBotToken,
    validate: validateSlackBotToken,
  });

  const slackAppToken = await reuseOrPromptSecret({
    message: "Paste the App Token (xapp-…) from Basic Information → App-Level Tokens:",
    existingValue: savedState.slackAppToken,
    validate: validateSlackAppToken,
  });

  return { slackBotToken, slackAppToken };
}

async function collectConfig(): Promise<InitConfig> {
  const savedState = await loadSavedInstallerState(process.cwd());
  const hasSavedState = Boolean(
    savedState.provider ||
    savedState.authMethod ||
    savedState.slackBotToken ||
    savedState.slackAppToken ||
    savedState.githubToken ||
    savedState.claudeOauthToken ||
    savedState.repos.length > 0
  );

  if (hasSavedState) {
    p.log.info(`Found existing installer state. Reusing defaults from app config and ${savedState.secretBackend}.`);
  }

  // Provider selection
  const provider = (await p.select({
    message: "Which agent engine?",
    initialValue: savedState.provider,
    options: [
      {
        value: "codex",
        label: "Codex (OpenAI)",
        hint: "OpenAI / ChatGPT Plus",
      },
      {
        value: "claude",
        label: "Claude Code (Anthropic)",
      },
    ],
  })) as "codex" | "claude";

  if (p.isCancel(provider)) process.exit(0);

  // Provider auth method
  const authMethod = (await p.select({
    message: "How should the agent authenticate?",
    initialValue: savedState.authMethod,
    options: [
      {
        value: "oauth",
        label: "OAuth login (recommended)",
        hint: provider === "claude"
          ? "runs 'claude auth login' and, if needed, 'claude setup-token' for a portable long-lived token"
          : "runs 'codex login --device-auth' — uses your OpenAI account",
      },
      {
        value: "api_key",
        label: "API key",
        hint: "pay-per-token, enter key manually",
      },
    ],
  })) as "oauth" | "api_key";

  if (p.isCancel(authMethod)) process.exit(0);

  let providerApiKey = "";
  let claudeOauthToken = "";
  if (authMethod === "oauth") {
    // Check if already authenticated locally
    const homeDir = process.env.HOME || "";
    const authPath = `${homeDir}/.codex/auth.json`;

    if (provider === "claude") {
      if (savedState.claudeOauthToken && validateClaudeOauthToken(savedState.claudeOauthToken)) {
        const token = await reuseOrPromptSecret({
          message: "Claude OAuth token",
          existingValue: savedState.claudeOauthToken,
        });
        claudeOauthToken = normalizeClaudeOauthToken(token);
      } else {
        claudeOauthToken = await ensurePortableClaudeAuth(homeDir);
      }
    } else if (existsSync(authPath)) {
      p.log.success(
        `Found existing ${provider === "codex" ? "Codex" : "Claude Code"} credentials at ${authPath}. ` +
        `These will be uploaded to EFS during deploy.`
      );
    } else {
      // No local credentials — run auth locally (user has a TTY here)
      p.log.info(
        provider === "codex"
          ? "No Codex credentials found. Running device auth now..."
          : "No Claude Code credentials found. Running login now..."
      );
      try {
        if (provider === "codex") {
          execSync("codex login --device-auth", { stdio: "inherit", timeout: 300000 });
        } else {
          claudeOauthToken = await ensurePortableClaudeAuth(homeDir);
        }
        p.log.success("Authenticated! Credentials will be uploaded to EFS during deploy.");
      } catch {
        p.log.error("Auth failed. You can re-run `citio` later to try again.");
        process.exit(1);
      }
    }
  } else {
    providerApiKey = await reuseOrPromptSecret({
      message: provider === "codex"
        ? "Enter your OpenAI API key (OPENAI_API_KEY):"
        : "Enter your Anthropic API key (ANTHROPIC_API_KEY):",
      existingValue: provider === "codex" ? savedState.openAiApiKey : savedState.anthropicApiKey,
    });
  }

  // Slack setup
  const { slackBotToken, slackAppToken } = await collectSlackTokens(savedState);

  p.note(
    "Pick the channel where Citio should listen for @mentions:\n" +
    "  1. In Slack, click the channel name at the top of the channel\n" +
    "  2. Scroll to the bottom of the About tab\n" +
    "  3. Copy the “Channel ID” — it starts with C\n" +
    "\n" +
    "After deploy, run  /invite @citio  in that channel so the bot can see it.\n" +
    "(DMs to the bot work everywhere — this only scopes channel mentions.)",
    "Find your Channel ID"
  );

  const slackChannelId = (await p.text({
    message: savedState.slackChannelId
      ? "Slack Channel ID (press Enter to keep saved value):"
      : "Slack Channel ID (starts with C):",
    placeholder: "C0123456789",
    defaultValue: savedState.slackChannelId,
    initialValue: savedState.slackChannelId,
  })) as string;
  if (p.isCancel(slackChannelId)) process.exit(0);

  // GitHub token
  p.note(
    "Citio uses this to clone your repos and open pull requests.\n" +
    "\n" +
    "Fine-grained token (recommended):\n" +
    "  1. Open https://github.com/settings/personal-access-tokens/new\n" +
    "  2. “Repository access” → Only select repositories → pick the repos\n" +
    "     Citio will work on\n" +
    "  3. “Repository permissions” →\n" +
    "       • Contents: Read and write\n" +
    "       • Pull requests: Read and write\n" +
    "     (Metadata: Read is added automatically)\n" +
    "  4. Generate token → copy it (starts with github_pat_)\n" +
    "\n" +
    "A classic token also works: https://github.com/settings/tokens/new\n" +
    "with the “repo” scope (starts with ghp_).",
    "GitHub token — 4 steps"
  );

  const githubToken = await reuseOrPromptSecret({
    message: "Paste your GitHub Personal Access Token:",
    existingValue: savedState.githubToken,
  });

  // Repos — fetch available repos from GitHub using the PAT
  let repos: Array<{ url: string; branch: string }> = [];
  const repoSpinner = p.spinner();
  repoSpinner.start("Fetching repos your token has access to...");

  try {
    // List repos accessible by the token (handles both classic and fine-grained PATs)
    const repoJson = execSync(
      `curl -s -H "Authorization: token ${githubToken}" "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member" 2>/dev/null`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const repoList = JSON.parse(repoJson) as Array<{ full_name: string; clone_url: string; default_branch: string; private: boolean; updated_at: string }>;

    if (Array.isArray(repoList) && repoList.length > 0) {
      repoSpinner.stop(`Found ${repoList.length} repos`);

      const selectedRepos = (await p.multiselect({
        message: "Select repos for Citio to work on (use space to select, enter to confirm):",
        options: repoList.slice(0, 50).map((r) => ({
          value: r.clone_url,
          label: r.full_name,
          hint: `${r.private ? "private" : "public"} · ${r.default_branch} · updated ${r.updated_at.split("T")[0]}`,
        })),
        initialValues: savedState.repos.map((repo) => repo.url),
        required: true,
      })) as string[];

      if (p.isCancel(selectedRepos)) process.exit(0);

      repos = selectedRepos.map((url) => {
        const match = repoList.find((r) => r.clone_url === url);
        return { url, branch: match?.default_branch || "main" };
      });
    } else {
      repoSpinner.stop("No repos found (token may not have repo access)");
    }
  } catch {
    repoSpinner.stop("Could not fetch repos from GitHub");
  }

  // Fallback to manual entry if auto-fetch failed or returned nothing
  if (repos.length === 0) {
    const repoInput = (await p.text({
      message: savedState.repos.length > 0
        ? "Repository URL(s) (comma-separated, press Enter to keep saved value):"
        : "Repository URL(s) (comma-separated):",
      placeholder: "https://github.com/org/repo.git",
      defaultValue: savedState.repos.map((repo) => repo.url).join(", "),
      initialValue: savedState.repos.map((repo) => repo.url).join(", "),
    })) as string;
    if (p.isCancel(repoInput)) process.exit(0);

    repos = repoInput.split(",").map((url) => ({
      url: url.trim(),
      branch: "main",
    }));
  }

  // Rules
  const rulesInput = (await p.text({
    message: savedState.rules.length > 0
      ? "Agent rules (one per line, press Enter to keep saved value):"
      : "Agent rules (one per line, or press Enter for defaults):",
    placeholder: "Always create PRs. Never push to main.",
    defaultValue: savedState.rules.length > 0
      ? savedState.rules.join("\n")
      : "Always create PRs for code changes. Never push directly to main.\nWhen investigating bugs, check logs first before making code changes.\nReport findings back to the team with clear summaries.",
    initialValue: savedState.rules.length > 0
      ? savedState.rules.join("\n")
      : undefined,
  })) as string;
  if (p.isCancel(rulesInput)) process.exit(0);

  const rules = rulesInput.split("\n").filter((r) => r.trim());

  // Skills
  const skillChoices = (await p.multiselect({
    message: "Install community skills? (use space to select, enter to confirm)",
    options: Object.entries(SKILL_REGISTRY).map(([name, info]) => ({
      value: name,
      label: name,
      hint: info.description,
    })),
    initialValues: savedState.skills,
    required: false,
  })) as string[];
  if (p.isCancel(skillChoices)) process.exit(0);

  const gitUserEmail = (await p.text({
    message: savedState.gitUserEmail
      ? "Git commit email override (press Enter to keep saved value, leave blank to skip):"
      : "Git commit email override (optional, leave blank to skip):",
    placeholder: "you@example.com",
    defaultValue: savedState.gitUserEmail,
    initialValue: savedState.gitUserEmail,
  })) as string;
  if (p.isCancel(gitUserEmail)) process.exit(0);

  // AWS config — default to the region the user's AWS CLI is already set to.
  let detectedRegion = "";
  try {
    detectedRegion = execSync("aws configure get region 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    // No configured region — fall back below.
  }
  const regionDefault = savedState.awsRegion || detectedRegion || "us-east-1";

  const awsRegion = (await p.text({
    message: savedState.awsRegion
      ? "AWS Region (press Enter to keep saved value):"
      : detectedRegion
        ? `AWS Region (detected ${detectedRegion} from your AWS CLI — press Enter to accept):`
        : "AWS Region:",
    placeholder: "us-east-1",
    defaultValue: regionDefault,
    initialValue: regionDefault,
  })) as string;
  if (p.isCancel(awsRegion)) process.exit(0);

  let awsProfile = "";
  try {
    const profiles = execSync(
      "aws configure list-profiles 2>/dev/null || echo default",
      { encoding: "utf-8" }
    )
      .trim()
      .split("\n");

    if (profiles.length > 1) {
      awsProfile = (await p.select({
        message: "AWS Profile:",
        initialValue: savedState.awsProfile,
        options: profiles.map((profile) => ({
          value: profile,
          label: profile,
        })),
      })) as string;
      if (p.isCancel(awsProfile)) process.exit(0);
    } else {
      awsProfile = profiles[0];
    }
  } catch {
    awsProfile = "default";
  }

  const efsRequiredForCodex = provider === "codex" && authMethod === "oauth";
  const enableEfs = (await p.confirm({
    message: efsRequiredForCodex
      ? "Enable EFS persistence? (REQUIRED for Codex OAuth — it keeps ~/.codex/auth.json across restarts)"
      : "Enable EFS persistence for workspace, memory, and auth? Recommended for repo state across redeploys.",
    initialValue: savedState.enableEfs ?? true,
  })) as boolean;
  if (p.isCancel(enableEfs)) process.exit(0);

  if (!enableEfs && provider === "codex" && authMethod === "oauth") {
    p.log.error("Codex OAuth requires EFS so the container can persist ~/.codex/auth.json across restarts.");
    process.exit(1);
  }

  return {
    provider,
    authMethod,
    providerApiKey,
    claudeOauthToken,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    repos,
    rules,
    skills: skillChoices,
    gitUserEmail: gitUserEmail.trim(),
    awsRegion,
    awsProfile,
    enableEfs,
  };
}

function buildYamlConfig(config: InitConfig): Record<string, unknown> {
  const skillsDirectory = config.enableEfs
    ? "/home/citio/workspace/.citio/skills/"
    : "/workspace/.citio/skills/";

  return {
    name: "citio",
    version: 1,
    slack: {
      bot_token: "${SLACK_BOT_TOKEN}",
      app_token: "${SLACK_APP_TOKEN}",
      channel_id: config.slackChannelId,
      authorized_users: [],
    },
    engine: {
      default_provider: config.provider,
      max_session_duration_minutes: 60,
      max_concurrent_sessions: 1,
      auth_method: config.authMethod,
      providers: {
        codex: config.provider === "codex" && config.authMethod === "api_key"
          ? { api_key: "${OPENAI_API_KEY}" } : {},
        claude: config.provider === "claude" && config.authMethod === "api_key"
          ? { api_key: "${ANTHROPIC_API_KEY}" } : {},
      },
    },
    skills: {
      installed: config.skills,
      directory: skillsDirectory,
    },
    workspace: {
      repos: config.repos,
      rules: config.rules,
      git: {
        user_name: "Citio",
        ...(config.gitUserEmail ? { user_email: config.gitUserEmail } : {}),
      },
    },
    deploy: {
      provider: "aws",
      aws: {
        region: config.awsRegion,
        ecr_repo: "citio",
        ecs_cluster: "citio",
        ecs_service: "citio",
        profile: config.awsProfile,
        enable_efs: config.enableEfs,
        task_cpu: 2048,
        task_memory: 8192,
        ephemeral_storage_gb: 100,
      },
    },
  };
}

function getServiceNetworkConfig(region: string, profileFlag: string): { subnetId: string; securityGroupId: string } {
  const subnetId = execSync(
    `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets[0]' --output text`,
    { encoding: "utf-8", stdio: "pipe" }
  ).trim();
  const securityGroupId = execSync(
    `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text`,
    { encoding: "utf-8", stdio: "pipe" }
  ).trim();

  return { subnetId, securityGroupId };
}

function waitForTaskStop(taskArn: string, region: string, profileFlag: string, maxAttempts: number, intervalSeconds: number): { exitCode: string; taskId: string } {
  const taskId = taskArn.split("/").pop() || taskArn;

  for (let i = 0; i < maxAttempts; i++) {
    sleep(intervalSeconds);
    const status = execSync(
      `aws ecs describe-tasks --cluster citio --tasks "${taskArn}" --region ${region} ${profileFlag} --query 'tasks[0].lastStatus' --output text`,
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();

    if (status === "STOPPED") {
      const exitCode = execSync(
        `aws ecs describe-tasks --cluster citio --tasks "${taskArn}" --region ${region} ${profileFlag} --query 'tasks[0].containers[0].exitCode' --output text`,
        { encoding: "utf-8", stdio: "pipe" }
      ).trim();
      return { exitCode, taskId };
    }
  }

  return { exitCode: "", taskId };
}

function printNewCloudWatchLines(logGroup: string, logStream: string, region: string, profileFlag: string, seen: Set<string>): void {
  try {
    const output = execSync(
      `aws logs get-log-events --log-group-name ${logGroup} --log-stream-name ${logStream} --region ${region} ${profileFlag} --limit 50 --query 'events[].message' --output text`,
      { encoding: "utf-8", stdio: "pipe", timeout: 15000 }
    ).trim();

    if (!output) {
      return;
    }

    for (const message of output.split("\t")) {
      const trimmed = message.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      p.log.info(trimmed);
    }
  } catch {
    // Best effort only while the task is starting up.
  }
}

function startCodexAuthSetupTask(params: {
  accountId: string;
  ecrUri: string;
  region: string;
  profileFlag: string;
  efsFileSystemId: string;
  subnetId: string;
  securityGroupId: string;
  mode: "upload_local_auth" | "device_auth";
  localAuthJson?: string;
}): { taskArn: string; taskId: string; logStream: string } {
  const containerName = params.mode === "device_auth" ? "codex-auth" : "auth-setup";
  const command = params.mode === "device_auth"
    ? "mkdir -p /home/citio/.codex && codex login --device-auth"
    : `mkdir -p /home/citio/.codex && echo '${Buffer.from(params.localAuthJson || "", "utf-8").toString("base64")}' | base64 -d > /home/citio/.codex/auth.json && chmod 600 /home/citio/.codex/auth.json && echo AUTH_OK`;

  const taskDef = JSON.stringify({
    family: params.mode === "device_auth" ? "citio-codex-auth" : "citio-auth-setup",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "512",
    memory: "1024",
    executionRoleArn: `arn:aws:iam::${params.accountId}:role/citio-task-execution`,
    taskRoleArn: `arn:aws:iam::${params.accountId}:role/citio-task-execution`,
    volumes: [{
      name: "citio-home",
      efsVolumeConfiguration: {
        fileSystemId: params.efsFileSystemId,
        rootDirectory: "/",
        transitEncryption: "ENABLED",
      },
    }],
    containerDefinitions: [{
      name: containerName,
      image: params.mode === "device_auth" ? `${params.ecrUri}:latest` : "alpine:latest",
      essential: true,
      entryPoint: params.mode === "device_auth" ? ["sh", "-lc"] : undefined,
      command: params.mode === "device_auth" ? [command] : ["sh", "-c", command],
      environment: [
        { name: "HOME", value: "/home/citio" },
      ],
      mountPoints: [{ sourceVolume: "citio-home", containerPath: "/home/citio", readOnly: false }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": "/ecs/citio",
          "awslogs-region": params.region,
          "awslogs-stream-prefix": "auth-setup",
          "awslogs-create-group": "true",
        },
      },
    }],
  });

  writeFileSync("/tmp/citio-auth-task.json", taskDef);
  const revision = execSync(
    `aws ecs register-task-definition --cli-input-json file:///tmp/citio-auth-task.json --region ${params.region} ${params.profileFlag} --query 'taskDefinition.revision' --output text`,
    { encoding: "utf-8", stdio: "pipe" }
  ).trim();
  const taskArn = execSync(
    `aws ecs run-task --cluster citio --task-definition "${params.mode === "device_auth" ? "citio-codex-auth" : "citio-auth-setup"}:${revision}" --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${params.subnetId}],securityGroups=[${params.securityGroupId}],assignPublicIp=ENABLED}" --region ${params.region} ${params.profileFlag} --query 'tasks[0].taskArn' --output text`,
    { encoding: "utf-8", stdio: "pipe" }
  ).trim();

  const taskId = taskArn.split("/").pop() || taskArn;
  return {
    taskArn,
    taskId,
    logStream: `auth-setup/${containerName}/${taskId}`,
  };
}

function writeConfigFile(config: InitConfig): void {
  const yamlConfig = buildYamlConfig(config);
  writeFileSync("citio.yaml", stringify(yamlConfig), "utf-8");
  chmodSync("citio.yaml", 0o600);
}

function installSkills(skills: string[], githubToken: string): void {
  if (skills.length === 0) return;

  const skillsDir = ".citio/skills";
  mkdirSync(skillsDir, { recursive: true });

  const env = {
    ...process.env,
    GH_TOKEN: githubToken,
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const skill of skills) {
    const info = SKILL_REGISTRY[skill];
    if (!info) continue;

    p.log.step(`Installing skill: ${skill}`);

    try {
      if (info.installMethod === "git") {
        const skillPath = `${skillsDir}/${skill}`;
        if (existsSync(skillPath)) {
          execSync(`git -C "${skillPath}" pull --ff-only`, { stdio: "pipe", env });
        } else {
          const authedUrl = githubToken
            ? info.url.replace("https://github.com/", `https://${githubToken}@github.com/`)
            : info.url;
          execSync(`git clone --depth 1 "${authedUrl}" "${skillPath}"`, {
            stdio: "pipe",
            env,
          });
        }
      } else if (info.installMethod === "npx-skills") {
        // Uses `npx skills add <source>` — the official skill installer
        execSync(`npx skills add ${info.url}`, {
          stdio: "pipe",
          env,
          timeout: 120000,
        });
      } else if (info.installMethod === "npx") {
        // Direct npx command
        execSync(info.url, {
          stdio: "pipe",
          env,
          timeout: 120000,
        });
      }
      p.log.success(`Installed ${skill}`);
    } catch {
      p.log.warn(
        `Failed to install ${skill}. You can install it manually later.`
      );
    }
  }
}

async function deployToAws(config: InitConfig): Promise<void> {
  const s = p.spinner();
  const profileFlag = config.awsProfile
    ? `--profile ${config.awsProfile}`
    : "";
  const region = config.awsRegion;

  // All build/docker commands must run from the Citio project directory
  const projectDir = path.resolve(
    new URL(".", import.meta.url).pathname, "..", ".."
  );

  // 1. Get account ID
  s.start("Getting AWS account info...");
  const accountId = execSync(
    `aws sts get-caller-identity --query Account --output text ${profileFlag}`,
    { encoding: "utf-8" }
  ).trim();
  s.stop(`AWS Account: ${accountId}`);

  // 2. Create ECR repository
  s.start("Creating ECR repository...");
  try {
    execSync(
      `aws ecr create-repository --repository-name citio --region ${region} ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Already exists
  }
  const ecrUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/citio`;
  s.stop(`ECR: ${ecrUri}`);

  // 3. Build and push Docker image
  s.start("Building Docker image...");
  // From a source checkout, compile dist/ first. When running from an installed
  // package (e.g. `npx citio`), dist/ ships prebuilt and there is no src/ to compile.
  if (existsSync(path.join(projectDir, "src"))) {
    runDeployCommand("npm run build", "Failed to build the TypeScript application before Docker packaging.", { cwd: projectDir });
  }

  // Auth is handled at RUNTIME via env vars in the ECS task definition,
  // never baked into the Docker image.

  // Build for linux/amd64 (ECS Fargate requires it, even if building on ARM Mac)
  runDeployCommand(
    "docker build --platform linux/amd64 -t citio:latest .",
    "Docker build failed for the linux/amd64 ECS image.",
    { cwd: projectDir, timeout: 600000 }
  );

  s.stop("Docker image built");

  s.start("Pushing to ECR...");
  runDeployCommand(
    `aws ecr get-login-password --region ${region} ${profileFlag} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${region}.amazonaws.com`,
    "Failed to log Docker into ECR."
  );
  runDeployCommand(`docker tag citio:latest ${ecrUri}:latest`, "Failed to tag the Docker image for ECR.");
  runDeployCommand(`docker push ${ecrUri}:latest`, "Failed to push the Docker image to ECR.", { timeout: 600000 });
  s.stop("Image pushed to ECR");

  // 4. Create ECS cluster
  s.start("Setting up ECS cluster...");
  try {
    execSync(
      `aws ecs create-cluster --cluster-name citio --region ${region} ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Already exists
  }
  s.stop("ECS cluster ready");

  // 5. Create EFS if enabled
  let efsId = "";
  if (config.enableEfs) {
    s.start("Creating EFS filesystem for org memory...");
    try {
      const efsResult = execSync(
        `aws efs create-file-system --creation-token citio-memory --region ${region} ${profileFlag} --output json`,
        { encoding: "utf-8" }
      );
      const efsData = JSON.parse(efsResult);
      efsId = efsData.FileSystemId;
      s.stop(`EFS created: ${efsId}`);
    } catch {
      s.stop("EFS already exists or creation failed. Continuing without EFS.");
    }
  }

  // 6. Create task execution role
  s.start("Setting up IAM roles...");
  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  try {
    execSync(
      `aws iam create-role --role-name citio-task-execution --assume-role-policy-document '${trustPolicy}' ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
    execSync(
      `aws iam attach-role-policy --role-name citio-task-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
    // Add CloudWatch Logs permissions (needed for awslogs-create-group)
    const logsPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        Resource: "arn:aws:logs:*:*:*"
      }]
    });
    execSync(
      `aws iam put-role-policy --role-name citio-task-execution --policy-name citio-logs --policy-document '${logsPolicy}' ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Roles may already exist
  }
  s.stop("IAM roles configured");

  // 7. Register task definition
  s.start("Registering ECS task definition...");
  const envVars = [
    { name: "SLACK_BOT_TOKEN", value: config.slackBotToken },
    { name: "SLACK_APP_TOKEN", value: config.slackAppToken },
    { name: "GH_TOKEN", value: config.githubToken },
    { name: "HOME", value: "/home/citio" },
  ];

  if (config.enableEfs) {
    envVars.push(
      { name: "CITIO_WORKSPACE", value: "/home/citio/workspace" },
      { name: "CITIO_MEMORY", value: "/home/citio/memory" },
    );
  }

  // Embed config as base64 so it doesn't need a file mount
  const configYaml = readFileSync("citio.yaml", "utf-8");
  const configB64 = Buffer.from(configYaml).toString("base64");
  envVars.push({ name: "CITIO_CONFIG_B64", value: configB64 });

  if (config.authMethod === "api_key" && config.providerApiKey) {
    if (config.provider === "codex") {
      envVars.push({ name: "OPENAI_API_KEY", value: config.providerApiKey });
    } else {
      envVars.push({ name: "ANTHROPIC_API_KEY", value: config.providerApiKey });
    }
  } else if (config.provider === "claude" && config.claudeOauthToken) {
    envVars.push({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: config.claudeOauthToken });
  } else if (config.authMethod === "oauth") {
    // OAuth: credentials uploaded to EFS after deploy (see post-deploy section below)
    // No CITIO_NEEDS_AUTH — container doesn't do interactive auth
  }

  const efsFileSystemId = (config.enableEfs || config.authMethod === "oauth")
    ? resolveEfsFileSystemId(region, profileFlag, efsId)
    : "";

  const homeVolume = (config.enableEfs || config.authMethod === "oauth")
    ? {
        name: "citio-home",
        efsVolumeConfiguration: {
          fileSystemId: efsFileSystemId,
          rootDirectory: "/",
          transitEncryption: "ENABLED",
        },
      }
    : null;

  const taskDef = {
    family: "citio",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "2048",
    memory: "8192",
    ephemeralStorage: { sizeInGiB: 100 },
    executionRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    taskRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    volumes: homeVolume ? [homeVolume] : undefined,
    containerDefinitions: [
      {
        name: "citio",
        image: `${ecrUri}:latest`,
        essential: true,
        portMappings: [{ containerPort: 3001, protocol: "tcp" }],
        environment: envVars,
        mountPoints: homeVolume
          ? [{ sourceVolume: "citio-home", containerPath: "/home/citio", readOnly: false }]
          : undefined,
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": "/ecs/citio",
            "awslogs-region": region,
            "awslogs-stream-prefix": "ecs",
            "awslogs-create-group": "true",
          },
        },
        healthCheck: {
          command: [
            "CMD-SHELL",
            "curl -f http://localhost:3001/healthz || exit 1",
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 30,
        },
        stopTimeout: 60,
      },
    ],
  };

  const taskDefPath = "/tmp/citio-task-def.json";
  writeFileSync(taskDefPath, JSON.stringify(taskDef, null, 2));
  runDeployCommand(
    `aws ecs register-task-definition --cli-input-json file://${taskDefPath} --region ${region} ${profileFlag}`,
    "Failed to register the ECS task definition."
  );
  s.stop("Task definition registered");

  // 8. Get default VPC and subnets
  s.start("Configuring networking...");
  let subnetId: string;
  let sgId: string;

  try {
    const vpcId = execSync(
      `aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text --region ${region} ${profileFlag}`,
      { encoding: "utf-8" }
    ).trim();

    subnetId = execSync(
      `aws ec2 describe-subnets --filters "Name=vpc-id,Values=${vpcId}" --query "Subnets[0].SubnetId" --output text --region ${region} ${profileFlag}`,
      { encoding: "utf-8" }
    ).trim();

    // Create security group
    try {
      const sgResult = execSync(
        `aws ec2 create-security-group --group-name citio-sg --description "Citio agent - outbound only" --vpc-id ${vpcId} --region ${region} ${profileFlag} --output text --query GroupId`,
        { encoding: "utf-8" }
      ).trim();
      sgId = sgResult;
    } catch {
      sgId = execSync(
        `aws ec2 describe-security-groups --filters "Name=group-name,Values=citio-sg" --query "SecurityGroups[0].GroupId" --output text --region ${region} ${profileFlag}`,
        { encoding: "utf-8" }
      ).trim();
    }
  } catch (err) {
    s.stop("Failed to configure networking. Using defaults.");
    p.log.error(
      `Networking error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  s.stop("Networking configured");

  // 9. Create/update ECS service
  s.start("Deploying ECS service...");
  try {
    runDeployCommand(
      `aws ecs create-service \
        --cluster citio \
        --service-name citio \
        --task-definition citio \
        --desired-count 1 \
        --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[${subnetId}],securityGroups=[${sgId}],assignPublicIp=ENABLED}" \
        --region ${region} ${profileFlag}`,
      "Failed to create the ECS service."
    );
  } catch {
    // Service may already exist, update it
    runDeployCommand(
      `aws ecs update-service \
        --cluster citio \
        --service citio \
        --task-definition citio \
        --force-new-deployment \
        --region ${region} ${profileFlag}`,
      "Failed to update the ECS service."
    );
  }
  s.stop("ECS service deployed!");

  p.log.success("ECS service deployed!");

  // Post-deploy: seed Codex OAuth on EFS so the running container can refresh it from there.
  if (config.authMethod === "oauth" && config.provider === "codex") {
    const homeDir = process.env.HOME || "";
    const localAuthPath = `${homeDir}/.codex/auth.json`;
    const hasLocalAuth = existsSync(localAuthPath);
    const setupMode = hasLocalAuth
      ? (await p.select({
          message: "How should Codex OAuth be bootstrapped on ECS?",
          options: [
            {
              value: "upload_local_auth",
              label: "Reuse local Codex login (recommended)",
              hint: "Uploads ~/.codex/auth.json to EFS so ECS can refresh it there",
            },
            {
              value: "device_auth",
              label: "Authenticate inside ECS with device auth",
              hint: "No local auth copy; complete the OpenAI device flow from the task logs",
            },
          ],
          initialValue: "upload_local_auth",
        })) as "upload_local_auth" | "device_auth"
      : "device_auth";

    if (p.isCancel(setupMode)) process.exit(0);

    try {
      const { subnetId, securityGroupId } = getServiceNetworkConfig(region, profileFlag);
      let authBootstrapped = false;

      if (setupMode === "upload_local_auth") {
        s.start("Uploading local Codex credentials to EFS...");
        const authTask = startCodexAuthSetupTask({
          accountId,
          ecrUri,
          region,
          profileFlag,
          efsFileSystemId,
          subnetId,
          securityGroupId,
          mode: "upload_local_auth",
          localAuthJson: readFileSync(localAuthPath, "utf-8"),
        });
        const { exitCode } = waitForTaskStop(authTask.taskArn, region, profileFlag, 12, 10);
        if (exitCode === "0") {
          s.stop("Codex credentials uploaded to EFS.");
          authBootstrapped = true;
        } else {
          s.stop("Codex credential upload failed.");
          p.log.warn("Falling back to in-container device auth may be required.");
        }
      } else {
        s.start("Starting Codex device auth task...");
        const authTask = startCodexAuthSetupTask({
          accountId,
          ecrUri,
          region,
          profileFlag,
          efsFileSystemId,
          subnetId,
          securityGroupId,
          mode: "device_auth",
        });
        s.stop("Codex device auth task started.");

        p.log.info(
          "Complete the OpenAI device-auth flow shown in the task logs below.\n" +
          "Once the login finishes, the saved auth on EFS will be reused and refreshed by Codex on future boots."
        );

        const seenMessages = new Set<string>();
        let exitCode = "";
        for (let i = 0; i < 36; i++) {
          printNewCloudWatchLines("/ecs/citio", authTask.logStream, region, profileFlag, seenMessages);
          const result = waitForTaskStop(authTask.taskArn, region, profileFlag, 1, 10);
          if (result.exitCode) {
            exitCode = result.exitCode;
            break;
          }
        }

        if (exitCode === "0") {
          p.log.success("Codex device auth completed and was saved to EFS.");
          authBootstrapped = true;
        } else {
          p.log.warn("Codex device auth did not finish successfully. Re-run the installer or use OPENAI_API_KEY as a fallback.");
        }
      }

      if (authBootstrapped) {
        execSync(
          `aws ecs update-service --cluster citio --service citio --force-new-deployment --region ${region} ${profileFlag}`,
          { stdio: "pipe" }
        );
      }
    } catch (err) {
      p.log.warn(`Codex OAuth bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Post-deploy verification
  const verifyS = p.spinner();
  verifyS.start("Waiting for ECS service to stabilize...");

  let serviceHealthy = false;
  const maxRetries = 12; // 12 x 15s = 3 minutes
  for (let i = 0; i < maxRetries; i++) {
    try {
      const serviceJson = execSync(
        `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].{status:status,running:runningCount,desired:desiredCount,events:events[0].message}' --output json`,
        { encoding: "utf-8", stdio: "pipe" }
      );
      const svc = JSON.parse(serviceJson);

      if (svc.running >= svc.desired && svc.running > 0) {
        serviceHealthy = true;
        break;
      }

      // Show what's happening
      verifyS.message(`Task status: ${svc.running}/${svc.desired} running. ${svc.events || "Starting..."}`);
    } catch {
      // Service might not be queryable yet
    }

    // Wait 15 seconds before checking again
    execSync("sleep 15", { stdio: "pipe" });
  }

  if (serviceHealthy) {
    verifyS.stop("ECS service is running!");
  } else {
    verifyS.stop("ECS service not yet healthy.");

    // Check for errors in logs
    p.log.warn("The service may still be starting. Checking logs for errors...");
    try {
      const logs = execSync(
        `aws logs filter-log-events --log-group-name /ecs/citio --region ${region} ${profileFlag} --limit 10 --query 'events[].message' --output text 2>/dev/null`,
        { encoding: "utf-8", stdio: "pipe", timeout: 15000 }
      );
      if (logs.trim()) {
        p.log.info("Recent logs:\n" + logs.trim());
      }
    } catch {
      p.log.info("No logs available yet (log group may not exist until the task runs).");
    }

    // Check the task's stopped reason
    try {
      const stoppedReason = execSync(
        `aws ecs describe-tasks --cluster citio --tasks $(aws ecs list-tasks --cluster citio --service-name citio --desired-status STOPPED --region ${region} ${profileFlag} --query 'taskArns[0]' --output text 2>/dev/null) --region ${region} ${profileFlag} --query 'tasks[0].stoppedReason' --output text 2>/dev/null`,
        { encoding: "utf-8", stdio: "pipe", timeout: 15000 }
      ).trim();
      if (stoppedReason && stoppedReason !== "None") {
        p.log.error(`Task stopped: ${stoppedReason}`);
      }
    } catch {
      // No stopped tasks to inspect
    }
  }

  // Final status
  p.log.success(serviceHealthy ? "\nCitio is live!" : "\nDeployment started.");
  p.log.info(
    `Monitor:  aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag}` +
    `\nLogs:     aws logs tail /ecs/citio --region ${region} ${profileFlag} --follow` +
    `\nHealth:   Check the task's public IP on port 3001/healthz`
  );
}

async function main(): Promise<void> {
  p.intro("Welcome to Citio - Autonomous CTO Agent");

  p.note(
    "Setup takes ~10 minutes and walks you through every credential.\n" +
    "Have these ready (each step shows exactly where to get them):\n" +
    "\n" +
    "  ✓ A Slack workspace where you can create an app\n" +
    "  ✓ A GitHub account (we'll create a token together)\n" +
    "  ✓ An AWS account with the CLI logged in (aws sts get-caller-identity)\n" +
    "  ✓ A Claude Max/Pro or ChatGPT Plus login for the agent\n" +
    "\n" +
    "Your answers are saved as you go — if anything fails, re-run\n" +
    "`npx citio` and it resumes with your saved values.",
    "Before you start"
  );

  checkPrerequisites();

  const config = await collectConfig();

  const s = p.spinner();

  // Write config files
  s.start("Writing configuration...");
  writeConfigFile(config);
  const secretBackend = await saveInstallerState(
    {
      provider: config.provider,
      authMethod: config.authMethod,
      slackChannelId: config.slackChannelId,
      repos: config.repos,
      rules: config.rules,
      skills: config.skills,
      gitUserEmail: config.gitUserEmail || undefined,
      awsRegion: config.awsRegion,
      awsProfile: config.awsProfile,
      enableEfs: config.enableEfs,
    },
    {
      slackBotToken: config.slackBotToken,
      slackAppToken: config.slackAppToken,
      githubToken: config.githubToken,
      claudeOauthToken: config.claudeOauthToken || undefined,
      openAiApiKey: config.provider === "codex" && config.authMethod === "api_key" ? config.providerApiKey : undefined,
      anthropicApiKey: config.provider === "claude" && config.authMethod === "api_key" ? config.providerApiKey : undefined,
    }
  );
  s.stop(`Configuration saved to citio.yaml. Secrets saved to ${secretBackend}.`);

  // Install skills
  if (config.skills.length > 0) {
    installSkills(config.skills, config.githubToken);
  }

  // Deploy
  const shouldDeploy = (await p.confirm({
    message: "Deploy to AWS now?",
    initialValue: true,
  })) as boolean;

  if (p.isCancel(shouldDeploy)) process.exit(0);

  if (shouldDeploy) {
    await deployToAws(config);
  } else {
    p.log.info(
      "Skipping deploy. Secrets are stored outside the repo now, so local docker runs need explicit env vars or provider auth mounts."
    );
  }

  p.outro("Citio is ready! Send a message in your Slack channel to test.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
