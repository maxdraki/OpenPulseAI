/**
 * Public search API over the local FTS5 index. Ranking logic lives here
 * (not in `index-db.ts`) so a second signal (e.g. embedding similarity) can
 * be fused in later without touching the SQL/schema module.
 */
import type { Vault } from "../vault.js";
import { queryIndex } from "./index-db.js";
import { sanitizeFtsQuery } from "./sanitize.js";

export { sanitizeFtsQuery } from "./sanitize.js";

export interface SearchResult {
  theme: string;
  heading: string;
  snippet: string;
  score: number;
  rank: number;
}

const DEFAULT_LIMIT = 10;

/** FTS5 BM25 search over the local index. Snippets use `[` `]` as
 *  highlight markers (see `snippet()` call in `index-db.ts`). Returns `[]`
 *  for an empty query, no matches, or an unavailable index — never throws. */
export async function searchIndex(
  vault: Vault,
  query: string,
  opts?: { limit?: number }
): Promise<SearchResult[]> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const rows = await queryIndex(vault, sanitized, limit);

  return rows.map((row, i) => ({
    theme: row.theme,
    heading: row.heading,
    snippet: row.snippet,
    score: row.score,
    rank: i + 1,
  }));
}
