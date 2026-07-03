/**
 * Public search API over the local FTS5 index, with an optional semantic
 * signal fused in via Reciprocal Rank Fusion (RRF). Ranking logic lives
 * here (not in `index-db.ts`) so a second signal — embedding similarity —
 * can be fused in without touching the SQL/schema module.
 *
 * Hybrid mode (the default) runs FTS/BM25 as before and, if local
 * embeddings are available (see `search/embeddings.ts`) and the query
 * embeds successfully, also ranks every stored chunk embedding by cosine
 * similarity to the query. Both rankings are fused with RRF (k=60):
 * score = Σ 1/(k + rank_i) over every ranking a result appears in. A
 * semantic match with zero keyword overlap is reachable via the vector
 * ranking alone, and vice versa. Embeddings being unavailable (or the
 * query failing to embed) degrades silently to FTS-only results.
 */
import type { Vault } from "../vault.js";
import { getAllEmbeddings, queryIndex, rebuildIndex } from "./index-db.js";
import { sanitizeFtsQuery } from "./sanitize.js";
import { cosineSimilarity, embedTexts } from "./embeddings.js";

export { sanitizeFtsQuery } from "./sanitize.js";

export type SearchSignal = "fts" | "vector";

export interface SearchResult {
  theme: string;
  heading: string;
  snippet: string;
  /** Stable identity of the underlying chunk, independent of the query that
   *  matched it — FTS5's `snippet()` highlights whichever term matched, so
   *  the same chunk can render a different `snippet` string per query.
   *  Callers that fan out multiple queries against the same chunk (e.g.
   *  per-keyword search) should dedup/fuse on `contentHash` (scoped to
   *  `theme`+`heading`, since identical content could in principle appear
   *  under different headings/themes), not on the rendered snippet text. */
  contentHash: string;
  score: number;
  rank: number;
  signals: SearchSignal[];
}

const DEFAULT_LIMIT = 10;
export const RRF_K = 60;
/** How many FTS candidates to pull in before fusion — deliberately wider
 *  than the caller's requested `limit` so a result that ranks modestly on
 *  one signal but well on the other still has a chance to surface after
 *  fusion, rather than being cut off before RRF ever sees it. */
const FTS_CANDIDATE_LIMIT = 50;
/** Minimum cosine similarity for a vector candidate to be considered a
 *  match at all. Without a floor, every stored embedding gets *some* rank
 *  in the vector ranking no matter how dissimilar to the query, so on any
 *  non-empty index a query with zero real matches still surfaces `limit`
 *  results via RRF — silently defeating "no results" UX and the
 *  chat_with_pulse anti-hallucination `matched: false` path. 0.30 is a
 *  conservative floor for normalized MiniLM embeddings: comfortably below
 *  genuine semantic matches (~0.5+) but well above the near-zero
 *  similarity of unrelated text. */
const VECTOR_SIMILARITY_FLOOR = 0.3;
/** Cap on how many above-floor vector candidates are ranked and fused —
 *  keeps RRF's vector ranking bounded on a large index instead of ranking
 *  every embedding in the vault on every query. */
const VECTOR_CANDIDATE_CAP = 50;

/** Fuses any number of independent rank-1-based rankings (`key -> rank`)
 *  into a single `key -> score` map via Reciprocal Rank Fusion:
 *  score(key) = Σ 1/(k + rank_i) over every ranking that contains `key`.
 *  Pure and side-effect-free — a key missing from a given ranking simply
 *  contributes nothing from that ranking, so single-signal keys are never
 *  dropped, only scored lower than keys present in multiple rankings. */
export function fuseRankings(rankings: Array<Map<string, number>>, k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [key, rank] of ranking) {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank));
    }
  }
  return scores;
}

function resultKey(theme: string, heading: string, contentHash: string): string {
  return JSON.stringify([theme, heading, contentHash]);
}

function plainSnippet(text: string, maxLen = 200): string {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
}

interface ResultEntry {
  theme: string;
  heading: string;
  snippet: string;
  contentHash: string;
}

/** Hybrid (FTS + optional vector) search over the local index. Never
 *  throws — an empty query, no matches, or an unavailable index all
 *  resolve to `[]`. `opts.mode` defaults to `"hybrid"`; pass `"fts"` to
 *  skip the vector signal even when embeddings are available. */
export async function searchIndex(
  vault: Vault,
  query: string,
  opts?: { limit?: number; mode?: "hybrid" | "fts" }
): Promise<SearchResult[]> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const mode = opts?.mode ?? "hybrid";

  const ftsRows = await queryIndex(vault, sanitized, Math.max(limit, FTS_CANDIDATE_LIMIT));

  const entries = new Map<string, ResultEntry>();
  const signalsByKey = new Map<string, Set<SearchSignal>>();

  const ftsRanking = new Map<string, number>();
  ftsRows.forEach((row, i) => {
    const key = resultKey(row.theme, row.heading, row.contentHash);
    entries.set(key, { theme: row.theme, heading: row.heading, snippet: row.snippet, contentHash: row.contentHash });
    ftsRanking.set(key, i + 1);
    signalsByKey.set(key, new Set(["fts"]));
  });

  const rankings: Array<Map<string, number>> = [ftsRanking];

  if (mode === "hybrid") {
    const queryVectors = await embedTexts([query]);
    const queryVector = queryVectors?.[0];
    if (queryVector) {
      const allEmbeddings = await getAllEmbeddings(vault);
      if (allEmbeddings.length > 0) {
        const scored = allEmbeddings
          .map((e) => ({ e, sim: cosineSimilarity(queryVector, e.vector) }))
          .filter(({ sim }) => sim >= VECTOR_SIMILARITY_FLOOR)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, VECTOR_CANDIDATE_CAP);

        const vectorRanking = new Map<string, number>();
        scored.forEach(({ e }, i) => {
          const key = resultKey(e.theme, e.heading, e.contentHash);
          vectorRanking.set(key, i + 1);
          if (!entries.has(key)) {
            entries.set(key, { theme: e.theme, heading: e.heading, snippet: plainSnippet(e.text), contentHash: e.contentHash });
          }
          const signals = signalsByKey.get(key) ?? new Set<SearchSignal>();
          signals.add("vector");
          signalsByKey.set(key, signals);
        });
        rankings.push(vectorRanking);
      }
    }
  }

  const fused = fuseRankings(rankings);
  const ranked = Array.from(fused.entries()).sort((a, b) => b[1] - a[1]);

  return ranked.slice(0, limit).map(([key, score], i) => {
    const entry = entries.get(key)!;
    return {
      theme: entry.theme,
      heading: entry.heading,
      snippet: entry.snippet,
      contentHash: entry.contentHash,
      score,
      rank: i + 1,
      signals: Array.from(signalsByKey.get(key) ?? []),
    };
  });
}

/**
 * Shared "empty index → rebuild once → retry" pattern used by every
 * consumer of `searchIndex` (search_index, query_memory, chat_with_pulse,
 * and the Themes page's `GET /api/search`). A brand-new vault (or one whose
 * index file predates the search feature) has no index yet — rather than
 * surface a confusing "no results" the first time anyone queries it, this
 * rebuilds once from the warm themes on disk and retries the same query
 * before giving up.
 */
export async function searchWithRebuildRetry(
  vault: Vault,
  query: string,
  opts?: { limit?: number; mode?: "hybrid" | "fts" }
): Promise<SearchResult[]> {
  let results = await searchIndex(vault, query, opts);
  if (results.length === 0) {
    await rebuildIndex(vault);
    results = await searchIndex(vault, query, opts);
  }
  return results;
}
