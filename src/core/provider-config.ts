import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

function getMcpCommand(): { command: string; args: string[] } {
  const distEntry = path.resolve(process.cwd(), "dist/core/mcp-entry.js");
  const srcEntry = path.resolve(process.cwd(), "src/core/mcp-entry.ts");

  if (existsSync(distEntry)) {
    return {
      command: "node",
      args: [distEntry],
    };
  }

  return {
    command: "npx",
    args: ["tsx", srcEntry],
  };
}

export function ensureCodexMcpConfigured(workspacePath: string): void {
  const { command, args } = getMcpCommand();
  const envVars = [
    `CITIO_CONFIG=${process.env.CITIO_CONFIG || "citio.yaml"}`,
    `CITIO_CONFIG_B64=${process.env.CITIO_CONFIG_B64 || ""}`,
    `CITIO_WORKSPACE=${workspacePath}`,
    `CITIO_MEMORY=${process.env.CITIO_MEMORY || "/memory"}`,
    `GH_TOKEN=${process.env.GH_TOKEN || ""}`,
    `AWS_DEFAULT_REGION=${process.env.AWS_DEFAULT_REGION || ""}`,
  ];

  try {
    execFileSync("codex", ["mcp", "remove", "citio"], {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // Fine if it wasn't configured yet.
  }

  execFileSync(
    "codex",
    [
      "mcp",
      "add",
      "citio",
      ...envVars.flatMap((entry) => ["--env", entry]),
      "--",
      command,
      ...args,
    ],
    {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: "pipe",
    }
  );
}
