#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "../vault.js";
import { loadConfig } from "../config.js";
import { discoverSkills } from "./loader.js";
import { checkEligibility } from "./eligibility.js";
import { loadCollectorState } from "./scheduler.js";
import { initLogger } from "../logger.js";
import { runSkillByName, runDueSkills } from "./run.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const args = process.argv.slice(2);
  const runIdx = args.indexOf("--run");
  const runName = runIdx >= 0 ? args[runIdx + 1] : null;
  const listOnly = args.includes("--list") || args.includes("--check");

  initLogger(VAULT_ROOT);

  if (listOnly) {
    const builtinDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "builtin-skills");
    const userDir = join(VAULT_ROOT, "skills");
    const skills = await discoverSkills([builtinDir, userDir]);
    const vault = new Vault(VAULT_ROOT);
    await vault.init();

    for (const skill of skills) {
      const state = await loadCollectorState(vault, skill.name);
      const elig = await checkEligibility(skill);
      const status = elig.eligible ? "eligible" : `missing: ${elig.missing.join(", ")}`;
      console.log(`${skill.name}: schedule=${skill.schedule ?? "manual"} lookback=${skill.lookback} ${status} lastRun=${state?.lastRunAt ?? "never"}`);
    }
    return;
  }

  if (runName) {
    console.error(`[skills] Running ${runName}...`);
    await runSkillByName(runName, VAULT_ROOT);
    console.error(`[skills] Done.`);
    return;
  }

  // Default: run all due skills
  console.error("[skills] Checking scheduled skills...");
  await runDueSkills(VAULT_ROOT);
  console.error("[skills] Done.");
}

main().catch((e) => { console.error("[skills] Fatal:", e); process.exit(1); });
