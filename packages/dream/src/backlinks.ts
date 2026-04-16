import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "@openpulse/core";
import { listThemes, readTheme } from "@openpulse/core";

/**
 * Builds a backlinks map: for each theme, lists all themes that link to it.
 *
 * Scans all theme files in the vault and extracts [[wiki-link]] references.
 * Returns a map where keys are theme names and values are arrays of themes
 * that link to them. Broken links (targets that don't exist in the vault)
 * are included if they are referenced by any theme.
 */
export async function buildBacklinks(vault: Vault): Promise<Map<string, string[]>> {
  const backlinks = new Map<string, string[]>();
  const themes = await listThemes(vault);

  for (const theme of themes) {
    backlinks.set(theme, []);
  }

  for (const theme of themes) {
    const doc = await readTheme(vault, theme);
    if (!doc) continue;

    const seenLinks = new Set<string>();

    for (const match of doc.content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1];
      if (target === theme || seenLinks.has(target)) continue;
      seenLinks.add(target);

      if (!backlinks.has(target)) {
        backlinks.set(target, []);
      }
      backlinks.get(target)!.push(theme);
    }
  }

  for (const links of backlinks.values()) {
    links.sort();
  }

  return backlinks;
}

/**
 * Writes a backlinks file to vault/warm/_backlinks.md.
 *
 * The file lists each theme with its inbound links in markdown format.
 * Themes are sorted alphabetically, as are their inbound links.
 */
export async function writeBacklinksFile(
  vault: Vault,
  backlinks: Map<string, string[]>
): Promise<void> {
  const sortedThemes = Array.from(backlinks.keys()).sort();
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = ["# Backlinks", "", `Generated: ${date}`, ""];

  for (const theme of sortedThemes) {
    const inbound = backlinks.get(theme) ?? [];
    lines.push(`## [[${theme}]]`);

    if (inbound.length === 0) {
      lines.push("_No inbound links._");
    } else {
      for (const link of inbound) {
        lines.push(`- [[${link}]]`);
      }
    }

    lines.push("");
  }

  await writeFile(join(vault.warmDir, "_backlinks.md"), lines.join("\n"), "utf-8");
}
