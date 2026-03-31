import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/core/session-manager.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "citio-session-test-"));
}

test("SessionManager reuses the latest session within the same runtime scope", () => {
  const memoryDir = makeTempDir();

  const manager = new SessionManager("claude", memoryDir, "runtime-a");
  manager.remember("C1:thread-1", "session-1");

  assert.equal(manager.get("C1:thread-1"), "session-1");
  assert.equal(manager.get("C2:thread-2"), "session-1");
});

test("SessionManager refuses to reuse sessions from an older runtime", () => {
  const memoryDir = makeTempDir();

  const previousRuntime = new SessionManager("claude", memoryDir, "runtime-a");
  previousRuntime.remember("C1:thread-1", "session-1");

  const currentRuntime = new SessionManager("claude", memoryDir, "runtime-b");
  assert.equal(currentRuntime.get("C1:thread-1"), null);
  assert.equal(currentRuntime.get("C2:thread-2"), null);
});

test("SessionManager ignores sessions saved for a different provider", () => {
  const memoryDir = makeTempDir();

  const codexManager = new SessionManager("codex", memoryDir, "runtime-a");
  codexManager.remember("C1:thread-1", "codex-session");

  const claudeManager = new SessionManager("claude", memoryDir, "runtime-a");
  assert.equal(claudeManager.get("C1:thread-1"), null);
});
