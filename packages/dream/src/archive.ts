import { readdir } from "node:fs/promises";
import { archiveHotFile, type Vault } from "@openpulse/core";

export async function archiveProcessedHotFiles(vault: Vault): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const files = await readdir(vault.hotDir);

  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;
    const date = match[1];
    if (date < today) {
      await archiveHotFile(vault, date);
    }
  }
}
