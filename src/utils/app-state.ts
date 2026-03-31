import { chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";

function ensureDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort only.
  }
  return dirPath;
}

export function getCitioStateDir(): string {
  const homeDir = os.homedir();

  if (process.platform === "darwin") {
    return ensureDir(path.join(homeDir, "Library", "Application Support", "Citio"));
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return ensureDir(path.join(appData, "Citio"));
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return ensureDir(path.join(xdgConfigHome, "citio"));
}

export function getInstallerStatePath(): string {
  return path.join(getCitioStateDir(), "installer-state.yaml");
}

export function getFallbackSecretsPath(): string {
  return path.join(getCitioStateDir(), "secrets.json");
}

export function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}
