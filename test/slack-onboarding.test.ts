import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCitioSlackManifest,
  validateSlackAppToken,
  validateSlackBotToken,
  validateSlackConfigToken,
} from "../src/utils/slack-onboarding.js";

test("buildCitioSlackManifest enables socket mode and required scopes", () => {
  const manifest = buildCitioSlackManifest();
  const settings = manifest.settings as Record<string, unknown>;
  const oauthConfig = manifest.oauth_config as Record<string, unknown>;
  const scopes = (oauthConfig.scopes as Record<string, unknown>).bot as string[];
  const features = manifest.features as Record<string, unknown>;

  assert.equal(settings.socket_mode_enabled, true);
  assert.deepEqual((settings.event_subscriptions as Record<string, unknown>).bot_events, [
    "app_mention",
    "message.im",
  ]);
  assert.ok(scopes.includes("assistant:write"));
  assert.ok(scopes.includes("chat:write"));
  assert.ok(scopes.includes("app_mentions:read"));
  assert.ok(features.assistant_view);
});

test("Slack token validators require the expected prefixes", () => {
  assert.equal(validateSlackBotToken("xoxb-123"), undefined);
  assert.equal(validateSlackAppToken("xapp-123"), undefined);
  assert.equal(validateSlackConfigToken("xoxe-123"), undefined);

  assert.equal(validateSlackBotToken("xapp-123"), "Slack bot token must start with xoxb-.");
  assert.equal(validateSlackAppToken("xoxb-123"), "Slack app token must start with xapp-.");
  assert.equal(validateSlackConfigToken("xoxb-123"), "Slack config token should start with xoxe.");
});
