import type { SearchResult, Vault } from "@openpulse/core";
import { searchWithRebuildRetry } from "./search-helpers.js";

export interface QueryMemoryInput {
  query: string;
}

/** Groups ranked chunk hits by theme (best-first, preserving the overall
 *  rank order — the first chunk seen for a theme is its best-scoring one
 *  since `results` already arrives sorted by score). */
function groupByTheme(results: SearchResult[]): Map<string, SearchResult[]> {
  const grouped = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = grouped.get(r.theme) ?? [];
    list.push(r);
    grouped.set(r.theme, list);
  }
  return grouped;
}

function formatResults(query: string, results: SearchResult[]): string {
  const grouped = groupByTheme(results);
  const sections = Array.from(grouped.entries()).map(([theme, chunks]) => {
    const lines = chunks.map((c) => `- **${c.heading}**: ${c.snippet}`);
    return `## ${theme}\n\n${lines.join("\n")}`;
  });

  return `Found ${results.length} matching chunk(s) across ${grouped.size} theme(s) for "${query}":\n\n${sections.join("\n\n")}\n\nUse read_theme with one of the theme names above to read the full page.`;
}

/**
 * Ranked-chunk retrieval over the local search index — returns theme,
 * heading, snippet, and score for each hit (grouped by theme, best match
 * first), not whole concatenated theme files. For the full page, follow up
 * with read_theme. If the index is empty (never built, or a freshly seeded
 * vault), attempts one rebuild and retries the same query before giving up.
 */
export async function handleQueryMemory(
  vault: Vault,
  input: QueryMemoryInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const results = await searchWithRebuildRetry(vault, input.query);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No thematic summaries found matching: "${input.query}"`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text" as const, text: formatResults(input.query, results) }],
  };
}
