import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const CLAUDE_AUTH_PROMPT = "Reply with exactly OK";

const CLAUDE_PORTABLE_AUTH_CANDIDATES = [
  [".claude.json"],
  [".claude.json", ".claude/settings.json"],
  [".claude.json", ".claude/settings.json", ".claude/session-env"],
  [".claude.json", ".claude/settings.json", ".claude/session-env", ".claude/sessions"],
] as const;

export interface ClaudePortableAuthResult {
  files: string[];
  commandOutput: string;
}

function stageClaudeAuthFiles(homeDir: string, tempHome: string, files: readonly string[]): void {
  for (const relativePath of files) {
    const sourcePath = path.join(homeDir, relativePath);
    if (!existsSync(sourcePath)) {
      continue;
    }

    const destinationPath = path.join(tempHome, relativePath);
    mkdirSync(path.dirname(destinationPath), { recursive: true });

    if (statSync(sourcePath).isDirectory()) {
      cpSync(sourcePath, destinationPath, { recursive: true });
    } else {
      cpSync(sourcePath, destinationPath);
    }
  }
}

function tryClaudePortableAuth(homeDir: string, files: readonly string[]): ClaudePortableAuthResult | null {
  const availableFiles = files.filter((relativePath) => existsSync(path.join(homeDir, relativePath)));
  if (availableFiles.length === 0) {
    return null;
  }

  const tempHome = mkdtempSync(path.join(os.tmpdir(), "citio-claude-auth-"));

  try {
    stageClaudeAuthFiles(homeDir, tempHome, availableFiles);

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
        },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      }
    ).trim();

    if (output === "OK") {
      return {
        files: availableFiles,
        commandOutput: output,
      };
    }

    return null;
  } catch {
    return null;
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

export function resolvePortableClaudeAuth(homeDir: string): ClaudePortableAuthResult | null {
  for (const candidate of CLAUDE_PORTABLE_AUTH_CANDIDATES) {
    const result = tryClaudePortableAuth(homeDir, candidate);
    if (result) {
      return result;
    }
  }

  return null;
}

export function hasClaudeLoginState(homeDir: string): boolean {
  return existsSync(path.join(homeDir, ".claude.json")) || existsSync(path.join(homeDir, ".claude"));
}

export function buildClaudeAuthArchive(homeDir: string, files: readonly string[]): string {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "citio-claude-bundle-"));

  try {
    stageClaudeAuthFiles(homeDir, tempHome, files);

    const archivePath = path.join(tempHome, "claude-auth.tar.gz");
    execFileSync(
      "tar",
      ["-czf", archivePath, ...files.filter((relativePath) => existsSync(path.join(tempHome, relativePath)))],
      {
        cwd: tempHome,
        stdio: "pipe",
      }
    );

    return readFileSync(archivePath).toString("base64");
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}
