import type { Vault } from "@openpulse/core";
// Deep import: @openpulse/core doesn't (yet) re-export the search module from
// its barrel, and this task's scope boundary forbids editing packages/core.
// The package has no "exports" map restricting subpath resolution, so this
// is a stable, buildable path.
import { searchIndex, type SearchResult } from "@openpulse/core/dist/search/search.js";
import { rebuildIndex } from "@openpulse/core/dist/search/index-db.js";

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
  let results = await searchIndex(vault, input.query, { limit: input.limit });

  if (results.length === 0) {
    await rebuildIndex(vault);
    results = await searchIndex(vault, input.query, { limit: input.limit });
  }

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
