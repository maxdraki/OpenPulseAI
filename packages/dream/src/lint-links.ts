/**
 * Embedding-based cross-reference suggestions (task-14 §A) — the wiki-
 * maturity audit found the link graph is a star (most themes have no
 * inbound links). This check uses the same hybrid-search embeddings already
 * computed for `search/index-db.ts` (no separate embedding pass) to suggest
 * `[[links]]` between semantically related themes that aren't already
 * cross-referenced.
 *
 * Metric (documented per the task brief): for each pair of themes, similarity
 * is the MAX cosine similarity over every pair of (chunk-in-A, chunk-in-B)
 * vectors — i.e. "these two pages are related if their single most-similar
 * pair of sections is strongly similar", not an average across the whole
 * page (which would wash out a small but highly-relevant section under a
 * long page's unrelated bulk).
 */
import type { Vault } from "@openpulse/core";
import { listThemes, readTheme, getAllEmbeddings, cosineSimilarity, vaultLog, type EmbeddingRow } from "@openpulse/core";

/** Cosine similarity above which two themes are considered "strongly
 *  related" and worth a cross-link suggestion. 0.55 sits comfortably above
 *  the hybrid search's own vector floor (0.30, see `search/search.ts`) —
 *  that floor is tuned for "any real match at all"; a link *suggestion*
 *  should be reserved for a considerably stronger signal so lint doesn't
 *  spam every loosely-related pair. */
export const LINK_SUGGESTION_THRESHOLD = 0.55;

export interface LinkSuggestion {
  /** The theme the suggestion is attached to (would gain the new link). */
  theme: string;
  /** The related theme it should consider linking to. */
  target: string;
  similarity: number;
  headingA: string;
  headingB: string;
}

let warnedNoEmbeddings = false;

/** Extracts the set of `[[wiki-link]]` targets already present in a theme's content. */
function outboundLinks(content: string): Set<string> {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    links.add(match[1]);
  }
  return links;
}

/**
 * Finds, for each theme, the single most-related other theme (by the max
 * chunk-pair cosine similarity metric documented above) that isn't already
 * linked from it. Only themes at/above `LINK_SUGGESTION_THRESHOLD` are
 * returned. Degrades silently (returns `[]`, logs once) when embeddings are
 * unavailable — never blocks other lint checks.
 */
export async function findLinkSuggestions(vault: Vault): Promise<LinkSuggestion[]> {
  const themeNames = await listThemes(vault);
  if (themeNames.length < 2) return [];

  const embeddings = await getAllEmbeddings(vault);
  if (embeddings.length === 0) {
    if (!warnedNoEmbeddings) {
      warnedNoEmbeddings = true;
      await vaultLog(
        "warn",
        "[lint] Embeddings unavailable — skipping link-suggestion check for this run"
      );
    }
    return [];
  }

  const byTheme = new Map<string, EmbeddingRow[]>();
  for (const row of embeddings) {
    const list = byTheme.get(row.theme) ?? [];
    list.push(row);
    byTheme.set(row.theme, list);
  }

  const suggestions: LinkSuggestion[] = [];

  for (const theme of themeNames) {
    const rowsA = byTheme.get(theme);
    if (!rowsA || rowsA.length === 0) continue;

    const doc = await readTheme(vault, theme);
    if (!doc) continue;
    const linked = outboundLinks(doc.content);

    let best: { target: string; sim: number; headingA: string; headingB: string } | null = null;

    for (const [otherTheme, rowsB] of byTheme) {
      if (otherTheme === theme || linked.has(otherTheme)) continue;

      for (const a of rowsA) {
        for (const b of rowsB) {
          const sim = cosineSimilarity(a.vector, b.vector);
          if (!best || sim > best.sim) {
            best = { target: otherTheme, sim, headingA: a.heading, headingB: b.heading };
          }
        }
      }
    }

    if (best && best.sim >= LINK_SUGGESTION_THRESHOLD) {
      suggestions.push({
        theme,
        target: best.target,
        similarity: best.sim,
        headingA: best.headingA,
        headingB: best.headingB,
      });
    }
  }

  return suggestions;
}
