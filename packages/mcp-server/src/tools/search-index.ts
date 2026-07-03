import type { SearchResult, Vault } from "@openpulse/core";
import { searchWithRebuildRetry } from "./search-helpers.js";

export interface SearchIndexInput {
  query: string;
  limit?: number;
}

function formatResults(query: string, results: SearchResult[]): string {
  const lines = results.map(
    (r) => `${r.rank}. [${r.theme}] ${r.heading} — ${r.snippet}`
  );
  return `Found ${results.length} result(s) for "${query}":\n\n${lines.join("\n")}\n\nUse read_theme with one of the theme names above to read the full page.`;
}

/**
 * Narrow-then-read entry point: ranked snippet-level search over the local
 * FTS5 index. If the index is empty (e.g. never built, or the vault was
 * just seeded), attempts one `rebuildIndex` and retries the query once
 * before giving up with a helpful message.
 */
export async function handleSearchIndex(
  vault: Vault,
  input: SearchIndexInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const results = await searchWithRebuildRetry(vault, input.query, { limit: input.limit });

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No results found for "${input.query}" (rebuilt the search index and retried — still no matches). Try a broader query, or check that themes exist in the vault yet.`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text" as const, text: formatResults(input.query, results) }],
  };
}
