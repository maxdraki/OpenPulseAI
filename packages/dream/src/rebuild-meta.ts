#!/usr/bin/env node
/**
 * Lightweight post-approve helper: rebuilds index.md and _backlinks.md
 * without running the full dream pipeline. Spawned by the UI server
 * after each theme approval so the index and backlinks stay current.
 */
import { Vault, commitVault } from "@openpulse/core";
import { generateIndex } from "./index.js";
import { buildBacklinks, writeBacklinksFile } from "./backlinks.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  await generateIndex(vault);
  const backlinks = await buildBacklinks(vault);
  await writeBacklinksFile(vault, backlinks);
  // This direct-write path bypasses approve.ts's commit (see task-5 brief
  // §B) — it's spawned by the UI server right after an approval to refresh
  // index.md/_backlinks.md, so it needs its own commit.
  await commitVault(vault, "rebuild-meta: index/backlinks refresh");
}

main().catch((err) => {
  console.error("[rebuild-meta]", err);
  process.exit(1);
});
