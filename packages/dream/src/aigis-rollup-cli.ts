#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Vault,
  loadConfig,
  createProvider,
  initLogger,
  loadState,
} from "@openpulse/core";
import { runAigisRollup } from "./aigis-rollup.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  initLogger(VAULT_ROOT);
  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  const state = await loadState(VAULT_ROOT);
  const { cadence, lastRun } = state.aigisRollupPipeline;

  await runAigisRollup(vault, provider, model, { cadence, lastRun });
}

/**
 * Only run main() when this file is the process's actual entry point, not
 * when imported by tests. Mirrors the realpath idiom in index.ts (see that
 * file's `isMainInvocation` doc comment for why a naive `argv[1]?.endsWith(...)`
 * check silently no-ops for the real `openpulse-aigis-rollup` bin symlink.
 */
function isMainInvocation(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return true;

  let modulePath: string;
  try {
    modulePath = fileURLToPath(import.meta.url);
  } catch {
    return true;
  }

  try {
    return realpathSync(invoked) === realpathSync(modulePath);
  } catch {
    return invoked === modulePath;
  }
}

if (isMainInvocation()) {
  main().catch((err) => {
    console.error("[aigis-rollup] Fatal:", err);
    process.exit(1);
  });
}
