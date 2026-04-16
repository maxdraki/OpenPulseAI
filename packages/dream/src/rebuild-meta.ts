#!/usr/bin/env node
/**
 * Lightweight post-approve helper: rebuilds index.md and _backlinks.md
 * without running the full dream pipeline. Spawned by the UI server
 * after each theme approval so the index and backlinks stay current.
 */
import { Vault } from "@openpulse/core";
import { generateIndex } from "./index.js";
import { buildBacklinks, writeBacklinksFile } from "./backlinks.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  await generateIndex(vault);
  const backlinks = await buildBacklinks(vault);
  await writeBacklinksFile(vault, backlinks);
}

main().catch((err) => {
  console.error("[rebuild-meta]", err);
  process.exit(1);
});
