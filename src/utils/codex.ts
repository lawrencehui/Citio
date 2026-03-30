import { existsSync } from "fs";

export function getCodexAuthPath(home = process.env.HOME || "/home/citio"): string {
  return `${home}/.codex/auth.json`;
}

export function hasCodexCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPENAI_API_KEY) {
    return true;
  }

  return existsSync(getCodexAuthPath(env.HOME || "/home/citio"));
}

export function formatCodexAuthHint(home = process.env.HOME || "/home/citio"): string {
  return `Codex credentials not found. Expected OAuth credentials at ${getCodexAuthPath(home)} or OPENAI_API_KEY in the container environment.`;
}

export function isLikelyCodexAuthError(text: string): boolean {
  return /auth|login|logged in|token|OPENAI_API_KEY|credential/i.test(text);
}
