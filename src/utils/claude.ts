import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import os from "os";
import path from "path";

const CLAUDE_AUTH_PROMPT = "Reply with exactly OK";

export function normalizeClaudeOauthToken(token: string): string {
  const compact = token.replace(/\s+/g, "");
  const match = compact.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return match ? match[0] : compact;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/\r/g, "\n");
}

export function extractClaudeOauthTokenFromTranscript(transcriptPath: string): string | null {
  const raw = readFileSync(transcriptPath, "utf-8");
  const cleaned = stripAnsi(raw);
  const startMarker = "Your OAuth token";
  const endMarker = "Store this token securely";
  const startIndex = cleaned.indexOf(startMarker);

  if (startIndex === -1) {
    return null;
  }

  const afterStart = cleaned.slice(startIndex);
  const endIndex = afterStart.indexOf(endMarker);
  const tokenBlock = endIndex === -1 ? afterStart : afterStart.slice(0, endIndex);
  const lines = tokenBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const tokenLines = lines.filter((line) => line.includes("sk-ant-oat01-") || /^[A-Za-z0-9_-]+$/.test(line));
  if (tokenLines.length === 0) {
    return null;
  }

  const candidate = normalizeClaudeOauthToken(tokenLines.join(""));
  return candidate.startsWith("sk-ant-oat01-") ? candidate : null;
}

export function validateClaudeOauthToken(token: string): boolean {
  const normalizedToken = normalizeClaudeOauthToken(token);
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "citio-claude-token-"));

  try {
    const output = execFileSync(
      "claude",
      ["-p", "--output-format", "text", CLAUDE_AUTH_PROMPT],
      {
        encoding: "utf-8",
        env: {
          HOME: tempHome,
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          TERM: process.env.TERM || "xterm-256color",
          NODE_ENV: process.env.NODE_ENV || "production",
          CLAUDE_CODE_OAUTH_TOKEN: normalizedToken,
        },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      }
    ).trim();

    return output === "OK";
  } catch {
    return false;
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}
