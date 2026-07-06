import https from "node:https";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface SlackManifestCreateResult {
  appId: string;
  oauthAuthorizeUrl: string;
  settingsUrl: string;
}

interface SlackApiErrorDetail {
  message?: string;
  pointer?: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  errors?: SlackApiErrorDetail[];
  app_id?: string;
  oauth_authorize_url?: string;
}

interface SlackManifestOptions {
  appName?: string;
}

export function buildCitioSlackManifest(options: SlackManifestOptions = {}): Record<string, unknown> {
  const appName = options.appName || "Citio";

  return {
    display_information: {
      name: appName,
      description: "Slack-native autonomous CTO agent",
      long_description: "Citio is a self-hosted autonomous CTO agent for Slack. It helps engineering teams investigate bugs, check CloudWatch logs, make safe repository changes, create pull requests, and report progress back into Slack while keeping the control plane and credentials inside your own infrastructure.",
      background_color: "#1d1c1d",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      assistant_view: {
        assistant_description: "Investigates bugs, checks logs, makes code changes, and opens PRs from Slack.",
        suggested_prompts: [
          {
            title: "Investigate a bug",
            message: "There is a bug in the login flow. Can you investigate it and suggest a fix?",
          },
          {
            title: "Check deploy health",
            message: "Can you check the latest deployment and review the logs for errors?",
          },
          {
            title: "Open a PR",
            message: "Can you make the smallest safe fix for this issue and open a PR?",
          },
        ],
      },
      bot_user: {
        display_name: "citio",
        always_online: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "chat:write",
          "groups:history",
          "im:history",
          "mpim:history",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "message.im",
          // Required by the Assistant view (adapters/slack.ts uses Bolt's Assistant):
          // without these, Socket Mode never delivers assistant-thread events and
          // the assistant pane silently does nothing.
          "assistant_thread_started",
          "assistant_thread_context_changed",
          // Ambient mode: plain messages in the bot's home channel
          "message.channels",
          "message.groups",
        ],
      },
      interactivity: {
        is_enabled: true,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

function callSlackApi(method: string, token: string, payload: Record<string, string>): Promise<SlackApiResponse> {
  const body = new URLSearchParams({
    token,
    ...payload,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "POST",
      hostname: "slack.com",
      path: `/api/${method}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as SlackApiResponse);
        } catch (error) {
          reject(new Error(`Slack ${method} returned invalid JSON: ${String(error)}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(body);
    req.end();
  });
}

function formatSlackErrors(response: SlackApiResponse): string {
  if (!response.errors || response.errors.length === 0) {
    return response.error || "unknown_error";
  }

  return response.errors
    .map((entry) => {
      const pointer = entry.pointer ? ` (${entry.pointer})` : "";
      return `${entry.message || "invalid manifest"}${pointer}`;
    })
    .join("; ");
}

export async function createCitioSlackApp(configToken: string, options: SlackManifestOptions = {}): Promise<SlackManifestCreateResult> {
  const manifest = buildCitioSlackManifest(options);
  const manifestJson = JSON.stringify(manifest);

  const validation = await callSlackApi("apps.manifest.validate", configToken, {
    manifest: manifestJson,
  });

  if (!validation.ok) {
    throw new Error(`Slack manifest validation failed: ${formatSlackErrors(validation)}`);
  }

  const created = await callSlackApi("apps.manifest.create", configToken, {
    manifest: manifestJson,
  });

  if (!created.ok || !created.app_id || !created.oauth_authorize_url) {
    throw new Error(`Slack app creation failed: ${formatSlackErrors(created)}`);
  }

  return {
    appId: created.app_id,
    oauthAuthorizeUrl: created.oauth_authorize_url,
    settingsUrl: `https://api.slack.com/apps/${created.app_id}`,
  };
}

export function openBrowser(url: string): boolean {
  try {
    switch (os.platform()) {
      case "darwin":
        execFileSync("open", [url], { stdio: "ignore" });
        return true;
      case "win32":
        execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
        return true;
      default:
        execFileSync("xdg-open", [url], { stdio: "ignore" });
        return true;
    }
  } catch {
    return false;
  }
}

export function validateSlackBotToken(token: string | undefined): string | Error | undefined {
  if (!token) {
    return "Slack bot token is required.";
  }
  if (!token.startsWith("xoxb-")) {
    return "Slack bot token must start with xoxb-.";
  }
  return undefined;
}

export function validateSlackAppToken(token: string | undefined): string | Error | undefined {
  if (!token) {
    return "Slack app token is required.";
  }
  if (!token.startsWith("xapp-")) {
    return "Slack app token must start with xapp-.";
  }
  return undefined;
}

export function validateSlackConfigToken(token: string | undefined): string | Error | undefined {
  if (!token) {
    return "Slack config token is required.";
  }
  if (!token.startsWith("xoxe")) {
    return "Slack config token should start with xoxe.";
  }
  return undefined;
}

/** Live-check a saved bot token via auth.test. Returns workspace/bot identity when valid. */
export async function testSlackBotToken(token: string): Promise<{ ok: boolean; team?: string; botUser?: string }> {
  try {
    const res = await callSlackApi("auth.test", token, {});
    if (res.ok) {
      const r = res as unknown as { team?: string; user?: string };
      return { ok: true, team: r.team, botUser: r.user };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
