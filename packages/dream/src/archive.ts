import { readdir, mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveHotFile, vaultLog, parseActivityBlocks, getLocalDate, type Vault } from "@openpulse/core";
import { loadProcessedLedger, saveProcessedLedger, pruneLedgerForEntries } from "./ledger.js";

export async function archiveProcessedHotFiles(vault: Vault): Promise<void> {
  const files = await readdir(vault.hotDir);
  const today = getLocalDate();
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
    if (date === today) continue;

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
