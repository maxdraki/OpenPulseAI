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

  // Get all theme names
  const themes = await listThemes(vault);

  // Pre-populate the map with empty arrays for every known theme
  for (const theme of themes) {
    backlinks.set(theme, []);
  }

  // Regex to extract [[wiki-link]] references
  const linkRegex = /\[\[([^\]]+)\]\]/g;

  // Process each theme
  for (const theme of themes) {
    const doc = await readTheme(vault, theme);
    if (!doc) {
      continue;
    }

    // Extract all links from the content
    const matches = doc.content.matchAll(linkRegex);
    const seenLinks = new Set<string>();

    for (const match of matches) {
      const target = match[1];

      // Skip duplicates within the same theme
      if (seenLinks.has(target)) {
        continue;
      }
      seenLinks.add(target);

      // Ensure the target exists in the map (even if it's a broken link)
      if (!backlinks.has(target)) {
        backlinks.set(target, []);
      }

      // Add the current theme to the target's inbound links
      const inboundLinks = backlinks.get(target)!;
      if (!inboundLinks.includes(theme)) {
        inboundLinks.push(theme);
      }
    }
  }

  // Sort inbound links for each theme alphabetically
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
  // Sort themes alphabetically
  const sortedThemes = Array.from(backlinks.keys()).sort();

  // Generate the markdown content
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    "# Backlinks",
    "",
    `Generated: ${date}`,
    "",
  ];

  for (const theme of sortedThemes) {
    const inboundLinks = backlinks.get(theme) || [];
    lines.push(`## [[${theme}]]`);

    if (inboundLinks.length === 0) {
      lines.push("_No inbound links._");
    } else {
      for (const link of inboundLinks) {
        lines.push(`- [[${link}]]`);
      }
    }

    lines.push("");
  }

  // Write the file
  const content = lines.join("\n");
  const filePath = join(vault.warmDir, "_backlinks.md");
  await writeFile(filePath, content, "utf-8");
}
