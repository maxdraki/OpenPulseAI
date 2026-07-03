import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LlmProvider, PendingUpdate, SearchResult, Vault } from "@openpulse/core";
import { listThemes, sanitizeThemeSlug, vaultLog } from "@openpulse/core";
import { searchWithRebuildRetry } from "./search-helpers.js";
import { judgeAndRefine } from "./chat-with-pulse.js";
import { skipIfQuerybackPending } from "./query-back.js";

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
 * Query-back for query_memory (task-14 §B): the SAME judge used by
 * chat_with_pulse's query-back loop (`judgeAndRefine`, shared rather than
 * duplicated) decides whether this query's results are durable, reusable
 * knowledge worth a wiki concept page. Fire-and-forget: any failure here
 * (LLM error/timeout, JSON parse failure, write failure) is swallowed —
 * it must never affect the query_memory response, and no LLM call happens
 * at all when `provider`/`model` aren't supplied (no API key configured).
 *
 * Feedback-loop guard: never files a pending page for a query whose slug
 * already matches an existing theme name (the answer already lives there —
 * see task-14 brief §B), nor when the judge's own proposed page name
 * collides with an existing theme, nor when a pending update already
 * proposes that same theme via an earlier query-back (see
 * `skipIfQuerybackPending` in query-back.ts — shared with chat_with_pulse's
 * auto-file path so repeated/similar queries don't pile up duplicate
 * pending concept pages).
 */
async function maybeFileQueryBack(
  vault: Vault,
  provider: LlmProvider | undefined,
  model: string | undefined,
  query: string,
  results: SearchResult[]
): Promise<void> {
  if (!provider || !model) return;

  try {
    const themeNames = await listThemes(vault);
    const themeSet = new Set(themeNames);

    const querySlug = sanitizeThemeSlug(query);
    if (querySlug && themeSet.has(querySlug)) return; // the answer already lives at this theme

    const themesConsulted = Array.from(new Set(results.map((r) => r.theme)));
    if (themesConsulted.length === 0) return;

    const digest = formatResults(query, results);
    const judgment = await judgeAndRefine(provider, model, query, digest, themesConsulted);
    if (judgment.verdict !== "yes" || !judgment.proposed_name || !judgment.refined_content) return;

    const themeName = sanitizeThemeSlug(judgment.proposed_name);
    if (!themeName || themeSet.has(themeName)) return; // proposed name collides with an existing theme
    if (await skipIfQuerybackPending(vault, themeName, "query_memory")) return;

    const update: PendingUpdate = {
      id: randomUUID(),
      theme: themeName,
      proposedContent: judgment.refined_content,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId: new Date().toISOString(),
      type: "concept",
      related: themesConsulted,
      querybackSource: { question: query, themesConsulted },
    };
    await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  } catch (err) {
    // Fire-and-forget: judge failures/timeouts must never affect the
    // query_memory response — just log and move on.
    await vaultLog("error", "query_memory: query-back filing failed", String(err));
  }
}

/**
 * Ranked-chunk retrieval over the local search index — returns theme,
 * heading, snippet, and score for each hit (grouped by theme, best match
 * first), not whole concatenated theme files. For the full page, follow up
 * with read_theme. If the index is empty (never built, or a freshly seeded
 * vault), attempts one rebuild and retries the same query before giving up.
 *
 * When `opts.provider`/`opts.model` are supplied (an LLM is configured),
 * also runs the query-back judge (see `maybeFileQueryBack`) — best-effort,
 * never affects this function's return value.
 */
export async function handleQueryMemory(
  vault: Vault,
  input: QueryMemoryInput,
  opts?: { provider?: LlmProvider; model?: string }
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

  await maybeFileQueryBack(vault, opts?.provider, opts?.model, input.query, results);

  return {
    content: [{ type: "text" as const, text: formatResults(input.query, results) }],
  };
}
