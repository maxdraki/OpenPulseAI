import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "../vault.js";
import { loadConfig } from "../config.js";
import { createProvider } from "../llm/factory.js";
import { discoverSkills } from "./loader.js";
import { checkEligibility } from "./eligibility.js";
import { runSkill } from "./runner.js";
import { isDue, loadCollectorState } from "./scheduler.js";
import { initLogger, vaultLog } from "../logger.js";

/**
 * Run a specific skill by name programmatically.
 * This is the function that server.ts and the Tauri backend should call
 * instead of spawning a subprocess.
 */
export async function runSkillByName(name: string, vaultRoot: string): Promise<void> {
  initLogger(vaultRoot);

  const config = await loadConfig(vaultRoot);
  const vault = new Vault(vaultRoot);
  await vault.init();

  // Discover skills from builtin + user directories
  const builtinDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills");
  const userDir = join(vaultRoot, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error(`Skill "${name}" not found`);

  const elig = await checkEligibility(skill);
  if (!elig.eligible) throw new Error(`Skill "${name}" ineligible: ${elig.missing.join(", ")}`);

  const provider = createProvider(config);
  await runSkill(skill, vault, provider, config.llm.model);
}

/**
 * Run all scheduled skills that are due.
 */
export async function runDueSkills(vaultRoot: string): Promise<void> {
  initLogger(vaultRoot);

  const config = await loadConfig(vaultRoot);
  const vault = new Vault(vaultRoot);
  await vault.init();

  const builtinDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills");
  const userDir = join(vaultRoot, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  const provider = createProvider(config);
  const now = new Date();

  for (const skill of skills) {
    if (!skill.schedule) continue;
    const elig = await checkEligibility(skill);
    if (!elig.eligible) continue;

    const state = await loadCollectorState(vault, skill.name);
    if (!isDue(skill.schedule, state?.lastRunAt ?? null, now)) continue;

    await vaultLog("info", `Running scheduled skill: ${skill.name}`);
    await runSkill(skill, vault, provider, config.llm.model);
  }
}
