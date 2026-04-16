/**
 * Provenance Tracking Module
 *
 * This module provides utilities for working with factual provenance in synthesized wiki content.
 * Every claim in a synthesized page can include a `^[src:entry-id]` footnote marker, and
 * this module extracts those markers, generates provenance IDs from timestamps, and manages
 * the `sources` frontmatter field that rolls up all unique citations in a page.
 */

/**
 * Extracts all unique source entry IDs from markdown content.
 *
 * Scans for `^[src:entry-id]` markers and returns deduplicated, order-preserved entry IDs.
 *
 * @example
 * extractSources("fact one ^[src:2026-04-01-github-activity] and fact two ^[src:2026-04-02-folder-watcher]")
 * → ["2026-04-01-github-activity", "2026-04-02-folder-watcher"]
 *
 * @param content - markdown string to scan for provenance markers
 * @returns array of unique entry IDs in order of first occurrence
 */
export function extractSources(content: string): string[] {
  const matches = content.matchAll(/\^\[src:([^\]]+)\]/g);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const match of matches) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

/**
 * Builds a provenance entry ID from an ISO timestamp and optional source name.
 *
 * Format: `${YYYY-MM-DD}-${source-name}`
 *
 * @example
 * entryId("2026-04-01T08:30:00Z", "github-activity")
 * → "2026-04-01-github-activity"
 *
 * entryId("2026-04-01T08:30:00Z")
 * → "2026-04-01-unknown"
 *
 * @param timestamp - ISO 8601 timestamp string
 * @param source - optional source name (defaults to "unknown")
 * @returns formatted entry ID
 */
export function entryId(timestamp: string, source?: string): string {
  const date = timestamp.slice(0, 10); // "YYYY-MM-DD"
  const sourceName = source ?? "unknown";
  return `${date}-${sourceName}`;
}

/**
 * Merges new source IDs into the `sources: [...]` frontmatter field of markdown.
 *
 * Behaviour:
 * 1. Returns markdown unchanged if no frontmatter block exists
 * 2. Parses existing `sources: [...]` from frontmatter (if present)
 * 3. Deduplicates: `[...new Set([...existing, ...newSources])]`
 * 4. Returns markdown unchanged if merged result is empty
 * 5. If `sources:` line exists in frontmatter → replaces it in-place
 * 6. If `sources:` line is absent → inserts before closing `---`
 *
 * Output format for the sources line: `sources: [id1, id2, id3]`
 *
 * @example
 * // Insert sources into existing frontmatter
 * updateSourcesFrontmatter(
 *   "---\ntheme: MyTheme\nlastUpdated: 2026-04-01T00:00:00Z\n---\n\nContent",
 *   ["2026-04-01-github"]
 * )
 * → "---\ntheme: MyTheme\nlastUpdated: 2026-04-01T00:00:00Z\nsources: [2026-04-01-github]\n---\n\nContent"
 *
 * // Merge with existing sources
 * updateSourcesFrontmatter(
 *   "---\ntheme: MyTheme\nsources: [old-id]\n---\n\nContent",
 *   ["new-id", "old-id"]
 * )
 * → "---\ntheme: MyTheme\nsources: [old-id, new-id]\n---\n\nContent"
 *
 * @param markdown - markdown string with optional frontmatter
 * @param newSources - array of source IDs to merge
 * @returns markdown with updated sources frontmatter
 */
export function updateSourcesFrontmatter(markdown: string, newSources: string[]): string {
  // Extract frontmatter block
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    // No frontmatter block — return unchanged
    return markdown;
  }

  const frontmatter = fmMatch[1];
  const fullFmBlock = fmMatch[0];

  // Extract existing sources from frontmatter
  const sourcesLineMatch = frontmatter.match(/sources:\s*\[([^\]]*)\]/);
  const existingSources = sourcesLineMatch
    ? sourcesLineMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Deduplicate and merge
  const merged = [...new Set([...existingSources, ...newSources])];

  // If merged is empty, return markdown unchanged
  if (merged.length === 0) {
    return markdown;
  }

  // Format the new sources line
  const newSourcesLine = `sources: [${merged.join(", ")}]`;

  let updatedFrontmatter: string;
  if (sourcesLineMatch) {
    // Replace existing sources line
    updatedFrontmatter = frontmatter.replace(/sources:\s*\[[^\]]*\]/, newSourcesLine);
  } else {
    // Insert before closing ---
    updatedFrontmatter = frontmatter + "\n" + newSourcesLine;
  }

  const updatedFmBlock = `---\n${updatedFrontmatter}\n---\n`;
  return markdown.replace(fullFmBlock, updatedFmBlock);
}
