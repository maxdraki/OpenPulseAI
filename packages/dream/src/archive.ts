import { readdir, mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveHotFile, vaultLog, parseActivityBlocks, getLocalDate, type Vault } from "@openpulse/core";
import { loadProcessedLedger, saveProcessedLedger, pruneLedgerForEntries } from "./ledger.js";

export async function archiveProcessedHotFiles(vault: Vault): Promise<void> {
  const files = await readdir(vault.hotDir);
  // Hot filenames are derived from `entry.timestamp.slice(0, 10)` in
  // `appendActivity` (packages/core/src/hot.ts), and entries are timestamped
  // with `new Date().toISOString()` (UTC) — so the filename date is a UTC
  // date, not a local one. `getLocalDate()` is only "today" in the system's
  // local timezone. In any positive-UTC-offset timezone, the window between
  // local midnight and UTC midnight has today-local !== today-UTC: the file
  // still named after UTC-yesterday can still be receiving live appends
  // (collectors write with UTC timestamps), but a local-only cutoff no
  // longer recognises it as "today" and would archive it out from under an
  // in-flight append — reintroducing the exact data-loss bug this module
  // exists to close. To stay safe regardless of which convention produced a
  // given filename (or a historical mix of both), skip a file if it matches
  // "today" under EITHER the local or the UTC calendar.
  const todayLocal = getLocalDate();
  const todayUTC = new Date().toISOString().slice(0, 10);
  let archived = 0;

  // Prune the processed-entry ledger as we go — once a file is archived there's
  // nothing left to dedupe against for its entries, so their ledger rows would
  // otherwise accumulate forever.
  const originalLedger = await loadProcessedLedger(vault);
  let ledger = originalLedger;

  // Archive daily hot files strictly older than today. Today's file is left in
  // place even if every entry in it has already been classified/synthesized —
  // it may still receive appends from collectors mid-run, and archiving it
  // would silently drop anything appended after `readHotEntries` ran.
  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;
    const date = match[1];
    if (date === todayLocal || date === todayUTC) continue;

    try {
      const content = await readFile(join(vault.hotDir, file), "utf-8");
      ledger = pruneLedgerForEntries(parseActivityBlocks(content), ledger);
    } catch {
      // File unreadable — nothing to prune, archive still proceeds below.
    }

    await archiveHotFile(vault, date);
    archived++;
  }

  if (ledger !== originalLedger) {
    await saveProcessedLedger(vault, ledger);
  }

  // Archive ingested documents
  const ingestDir = join(vault.hotDir, "ingest");
  try {
    const ingestFiles = await readdir(ingestDir);
    const month = new Date().toISOString().slice(0, 7);
    const coldIngestDir = join(vault.coldDir, month, "ingest");
    await mkdir(coldIngestDir, { recursive: true });

    for (const file of ingestFiles) {
      if (!file.endsWith(".md")) continue;
      await rename(join(ingestDir, file), join(coldIngestDir, file));
      archived++;
    }
  } catch { /* ingest dir may not exist */ }

  await vaultLog("info", "Dream pipeline archived hot entries", `${archived} files moved to cold storage`);
}
