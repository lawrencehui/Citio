import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

const CLAUDE_AUTH_PROMPT = "Reply with exactly OK";

export function normalizeClaudeOauthToken(token: string): string {
  return token.replace(/\s+/g, "");
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
