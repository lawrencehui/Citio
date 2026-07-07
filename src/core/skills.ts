import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

export interface SkillInfo {
  url: string;
  description: string;
  installMethod: "git" | "npx-skills" | "npx";
}

// Curated for Citio's job (investigate bugs, read logs, fix code, open PRs).
// Every install command below is verified working with `npx skills add`.
export const SKILL_REGISTRY: Record<string, SkillInfo> = {
  "systematic-debugging": {
    url: "obra/superpowers --skill systematic-debugging",
    description: "Root-cause debugging discipline — find the bug before patching it",
    installMethod: "npx-skills",
  },
  "code-review": {
    url: "obra/superpowers --skill receiving-code-review",
    description: "Systematic code-review discipline — respond to and act on review feedback",
    installMethod: "npx-skills",
  },
  "webapp-testing": {
    url: "anthropics/skills --skill webapp-testing",
    description: "Official Anthropic: verify fixes by driving the web app in a browser",
    installMethod: "npx-skills",
  },
  "frontend-design": {
    url: "anthropics/claude-code --skill frontend-design",
    description: "Production-grade UI generation, avoids default design patterns",
    installMethod: "npx-skills",
  },
  "skill-creator": {
    url: "anthropics/skills --skill skill-creator",
    description: "Official Anthropic: turn your team's own processes into custom skills",
    installMethod: "npx-skills",
  },
  gstack: {
    url: "https://github.com/garrytan/gstack.git",
    description: "QA, shipping, investigation, deploy, design review",
    installMethod: "git",
  },
};

export interface InstallResult {
  skill: string;
  status: "installed" | "already-present" | "failed" | "unknown-skill";
  error?: string;
}

/**
 * Install skills into `skillsDir` so the runtime's loadSkills() (which reads
 * `<skillsDir>/<name>/SKILL.md`) actually finds them. Idempotent: skills whose
 * SKILL.md already exists are skipped — safe to run on every container boot.
 *
 * npx-skills entries are installed via `npx skills add` into a temp directory
 * (the skills CLI writes to `./.agents/skills/`) and then copied into place,
 * because the skills CLI's layout is not the layout Citio reads.
 */
export function installSkillsTo(
  skillNames: string[],
  skillsDir: string,
  options: { ghToken?: string } = {}
): InstallResult[] {
  const results: InstallResult[] = [];
  if (skillNames.length === 0) return results;

  mkdirSync(skillsDir, { recursive: true });

  for (const skill of skillNames) {
    const info = SKILL_REGISTRY[skill];
    if (!info) {
      results.push({ skill, status: "unknown-skill" });
      continue;
    }

    const targetPath = path.join(skillsDir, skill);
    if (existsSync(path.join(targetPath, "SKILL.md"))) {
      results.push({ skill, status: "already-present" });
      continue;
    }

    try {
      if (info.installMethod === "git") {
        const authedUrl = options.ghToken
          ? info.url.replace("https://github.com/", `https://${options.ghToken}@github.com/`)
          : info.url;
        execSync(`git clone --depth 1 "${authedUrl}" "${targetPath}"`, {
          stdio: "pipe",
          timeout: 120000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } else {
        // npx-skills and legacy npx entries both go through the skills CLI in a
        // sandbox dir, then the produced skill folder is copied into skillsDir.
        const tempDir = mkdtempSync(path.join(os.tmpdir(), "citio-skill-"));
        try {
          execSync(`npx -y skills add ${info.url} -y`, {
            stdio: "pipe",
            cwd: tempDir,
            timeout: 180000,
          });
          const produced = path.join(tempDir, ".agents", "skills", skill);
          if (!existsSync(path.join(produced, "SKILL.md"))) {
            throw new Error(`skills CLI did not produce ${produced}`);
          }
          cpSync(produced, targetPath, { recursive: true });
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
      results.push({ skill, status: "installed" });
    } catch (err) {
      // execSync throws with stdout/stderr buffers when stdio is piped — surface
      // stderr so failures aren't masked by npm's notice noise on stdout.
      const e = err as { message?: string; stderr?: Buffer | string };
      const stderr = e?.stderr ? String(e.stderr).trim().split("\n").filter(Boolean).slice(-3).join(" | ") : "";
      results.push({
        skill,
        status: "failed",
        error: [e?.message, stderr].filter(Boolean).join(" — ").slice(0, 400),
      });
    }
  }

  return results;
}
