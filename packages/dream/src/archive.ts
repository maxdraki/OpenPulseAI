import { readdir, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { archiveHotFile, vaultLog, type Vault } from "@openpulse/core";

export async function archiveProcessedHotFiles(vault: Vault): Promise<void> {
  const files = await readdir(vault.hotDir);
  let archived = 0;

  // Archive all daily hot files (including today's — they've been processed)
  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;
    await archiveHotFile(vault, match[1]);
    archived++;
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
