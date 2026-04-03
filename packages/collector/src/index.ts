#!/usr/bin/env node
import { loadConfig, Vault, createProvider } from "@openpulse/core";
import { isDue, loadCollectorState } from "./scheduler.js";
import { collectSource } from "./orchestrator.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const args = process.argv.slice(2);
  const forceIdx = args.indexOf("--force");
  const forceSource = forceIdx >= 0 ? args[forceIdx + 1] : null;
  const runAll = args.includes("--all");
  const listOnly = args.includes("--list");

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  const sources = config.sources.filter((s) => s.enabled);

  if (listOnly) {
    for (const s of sources) {
      const state = await loadCollectorState(vault, s.name);
      console.log(`${s.name}: schedule=${s.schedule} lookback=${s.lookback} template=${s.template ?? "auto"} lastRun=${state?.lastRunAt ?? "never"} status=${state?.lastStatus ?? "never"}`);
    }
    return;
  }

  if (sources.length === 0) {
    console.error("[collector] No enabled sources configured.");
    return;
  }

  const provider = createProvider(config);
  const now = new Date();

  for (const source of sources) {
    if (forceSource && source.name !== forceSource) continue;
    if (!runAll && !forceSource) {
      const state = await loadCollectorState(vault, source.name);
      if (!isDue(source.schedule, state?.lastRunAt ?? null, now)) {
        console.error(`[collector] ${source.name}: not due yet, skipping.`);
        continue;
      }
    }
    console.error(`[collector] Collecting from ${source.name}...`);
    const result = await collectSource(source, vault, provider, config.llm.model);
    console.error(`[collector] ${source.name}: ${result.lastStatus} (${result.entriesCollected} entries)`);
  }
  console.error("[collector] Done.");
}

main().catch((e) => { console.error("[collector] Fatal:", e); process.exit(1); });
