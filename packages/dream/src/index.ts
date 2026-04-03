#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Vault, loadConfig, listThemes, createProvider } from "@openpulse/core";
import type { ActivityEntry } from "@openpulse/core";
import { classifyEntries } from "./classify.js";
import { synthesizeToPending } from "./synthesize.js";
import { archiveProcessedHotFiles } from "./archive.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  console.error("[dream] Starting Dream Pipeline...");

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  const provider = createProvider(config);
  const model = config.llm.model;

  const entries = await readHotEntries(vault);
  if (entries.length === 0) {
    console.error("[dream] No hot entries to process. Exiting.");
    return;
  }
  console.error(`[dream] Found ${entries.length} hot entries.`);

  const themes = await listThemes(vault);
  const allThemes = [...new Set([...config.themes, ...themes])];

  const classified = await classifyEntries(entries, allThemes, provider, model);
  console.error(`[dream] Classified ${classified.length} entries.`);

  const pending = await synthesizeToPending(vault, classified, provider, model);
  console.error(`[dream] Created ${pending.length} pending update(s). Review in the Control Center.`);

  await archiveProcessedHotFiles(vault);
  console.error("[dream] Hot files archived. Dream complete.");
}

async function readHotEntries(vault: Vault): Promise<ActivityEntry[]> {
  const files = await readdir(vault.hotDir);
  const entries: ActivityEntry[] = [];

  for (const file of files) {
    if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;

    const content = await readFile(join(vault.hotDir, file), "utf-8");
    const blocks = content.split(/\n---\n/).filter((b) => b.trim());

    for (const block of blocks) {
      const tsMatch = block.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m);
      const themeMatch = block.match(/^\*\*Theme:\*\*\s*(.+)/m);
      const logLines = block
        .split("\n")
        .filter(
          (l) =>
            !l.startsWith("## ") &&
            !l.startsWith("**Theme:") &&
            !l.startsWith("**Source:") &&
            l.trim()
        );

      if (tsMatch && logLines.length > 0) {
        entries.push({
          timestamp: tsMatch[1],
          log: logLines.join("\n").trim(),
          theme: themeMatch?.[1],
        });
      }
    }
  }

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

main().catch((error) => {
  console.error("[dream] Fatal error:", error);
  process.exit(1);
});
