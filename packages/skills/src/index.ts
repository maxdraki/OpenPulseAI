#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault, loadConfig, createProvider } from "@openpulse/core";
import { discoverSkills } from "./loader.js";
import { checkEligibility } from "./eligibility.js";
import { runSkill } from "./runner.js";
import { isDue, loadCollectorState } from "./scheduler.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const runIdx = args.indexOf("--run");
  const runName = runIdx >= 0 ? args[runIdx + 1] : null;
  const listOnly = args.includes("--list");
  const checkOnly = args.includes("--check");

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  // Discover skills from builtin + user directories
  const builtinDir = join(__dirname, "..", "builtin");
  const userDir = join(VAULT_ROOT, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  console.error(`[skills] Discovered ${skills.length} skill(s)`);

  if (listOnly || checkOnly) {
    for (const skill of skills) {
      const state = await loadCollectorState(vault, skill.name);
      const elig = await checkEligibility(skill);
      const status = elig.eligible ? "eligible" : `missing: ${elig.missing.join(", ")}`;
      console.log(`${skill.name}: schedule=${skill.schedule ?? "manual"} lookback=${skill.lookback} ${status} lastRun=${state?.lastRunAt ?? "never"}`);
    }
    return;
  }

  const targetSkills = runName
    ? skills.filter((s) => s.name === runName)
    : skills.filter((s) => s.schedule);

  if (targetSkills.length === 0) {
    console.error(runName ? `[skills] Skill "${runName}" not found.` : "[skills] No scheduled skills found.");
    return;
  }

  const provider = createProvider(config);
  const now = new Date();

  for (const skill of targetSkills) {
    // Check eligibility
    const elig = await checkEligibility(skill);
    if (!elig.eligible) {
      console.error(`[skills] ${skill.name}: ineligible — ${elig.missing.join(", ")}`);
      continue;
    }

    // Check schedule (skip if --run forces it)
    if (!runName && skill.schedule) {
      const state = await loadCollectorState(vault, skill.name);
      if (!isDue(skill.schedule, state?.lastRunAt ?? null, now)) {
        console.error(`[skills] ${skill.name}: not due yet, skipping.`);
        continue;
      }
    }

    console.error(`[skills] Running ${skill.name}...`);
    const result = await runSkill(skill, vault, provider, config.llm.model);
    console.error(`[skills] ${skill.name}: ${result.lastStatus} (${result.entriesCollected} entries)`);
  }

  console.error("[skills] Done.");
}

main().catch((e) => { console.error("[skills] Fatal:", e); process.exit(1); });
