import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SkillDefinition } from "../types.js";

const execFileAsync = promisify(execFile);

export interface EligibilityResult {
  eligible: boolean;
  missing: string[];
}

export async function checkEligibility(
  skill: SkillDefinition
): Promise<EligibilityResult> {
  const missing: string[] = [];

  for (const bin of skill.requires.bins) {
    try {
      await execFileAsync("which", [bin], { timeout: 3000 });
    } catch {
      missing.push(`bin: ${bin}`);
    }
  }

  for (const env of skill.requires.env) {
    if (!process.env[env]) {
      missing.push(`env: ${env}`);
    }
  }

  return { eligible: missing.length === 0, missing };
}
