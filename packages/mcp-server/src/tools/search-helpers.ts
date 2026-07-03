import { searchIndex, rebuildIndex, type Vault, type SearchResult } from "@openpulse/core";

/**
 * Shared "empty index → rebuild once → retry" pattern used by every
 * consumer of `searchIndex` (search_index, query_memory, chat_with_pulse).
 * A brand-new vault (or one whose index file predates the search feature)
 * has no index yet — rather than surface a confusing "no results" the
 * first time anyone queries it, we rebuild once from the warm themes on
 * disk and retry the same query before giving up.
 */
export async function searchWithRebuildRetry(
  vault: Vault,
  query: string,
  opts?: { limit?: number }
): Promise<SearchResult[]> {
  let results = await searchIndex(vault, query, opts);
  if (results.length === 0) {
    await rebuildIndex(vault);
    results = await searchIndex(vault, query, opts);
  }
  return results;
}
