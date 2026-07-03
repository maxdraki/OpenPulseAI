import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PendingUpdate, Vault, LlmProvider, SearchResult } from "@openpulse/core";
import { readTheme, sanitizeThemeSlug, stripCodeFences, searchIndex, rebuildIndex, fuseRankings, RRF_K } from "@openpulse/core";
import { createNewSession, loadSession, saveSession } from "./chat-session.js";
import { skipIfQuerybackPending } from "./query-back.js";

/**
 * Common English stopwords stripped from a chat message before it's turned
 * into search-index queries — see `extractKeywords`. Deliberately small and
 * conservative (better to under-strip than accidentally drop a real content
 * word); it only needs to cover the connective tissue of a typical
 * question, not be an exhaustive stopword list.
 */
const CHAT_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "to", "of", "in",
  "on", "for", "with", "how", "do", "does", "did", "what", "whats", "who",
  "whom", "this", "that", "these", "those", "it", "its", "be", "been",
  "being", "as", "at", "by", "from", "about", "into", "over", "after",
  "before", "between", "up", "down", "out", "off", "again", "then", "once",
  "here", "there", "when", "where", "why", "which", "can", "will", "would",
  "should", "could", "not", "no", "so", "than", "too", "very", "just",
  "also", "i", "you", "we", "they", "he", "she", "me", "my", "your", "our",
]);

/**
 * Pulls the content-bearing words out of a free-text chat message — see
 * `searchChatChunks` for why these become independent search-index queries
 * rather than one long AND'd phrase.
 */
function extractKeywords(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CHAT_STOPWORDS.has(w));
  return Array.from(new Set(words));
}

/**
 * Search-index retrieval for a conversational chat message. `searchIndex`'s
 * query sanitizer ANDs every whitespace-separated term together (see
 * `sanitizeFtsQuery`) — appropriate for a short keyword query, but a full
 * question like "how do auth and billing share tokens?" would require
 * every one of those words to appear verbatim in the same chunk, which
 * essentially never happens for a multi-topic conversational question. So
 * instead of one AND'd query over the whole message, this fans out one
 * query per content-bearing keyword and fuses the per-keyword rankings
 * locally (reciprocal-rank-style) — a theme relevant to only one clause of
 * the question still surfaces, and a chunk matching multiple keywords still
 * ranks higher than one matching only one. One rebuild+retry is attempted
 * only if EVERY keyword query comes back empty (an empty/never-built
 * index), not per keyword.
 *
 * Fusion is keyed on each result's `contentHash` (scoped to theme+heading),
 * not on `theme::heading::snippet` — FTS5's `snippet()` highlights whichever
 * term matched, so the SAME chunk renders a DIFFERENT snippet string per
 * keyword query. Keying on the rendered snippet would treat those as
 * distinct results: fusion would never merge same-chunk hits, the assembled
 * context would carry duplicate `### heading` sections wasting the char
 * cap, and a single chunk matching two keywords could look like two
 * "distinct" hits and wrongly trip `MULTI_HIT_THRESHOLD`'s full-theme
 * promotion. Keying on `contentHash` collapses all of a chunk's per-keyword
 * hits into one entry (keeping its best-ranked snippet) before ranking.
 */
async function searchChatChunks(vault: Vault, message: string, limit: number): Promise<SearchResult[]> {
  const keywords = extractKeywords(message);
  const queries = keywords.length > 0 ? keywords : [message];

  const runAll = () => Promise.all(queries.map((q) => searchIndex(vault, q, { limit })));

  let perQuery = await runAll();
  if (perQuery.every((r) => r.length === 0)) {
    await rebuildIndex(vault);
    perQuery = await runAll();
  }

  const chunkKey = (r: SearchResult) => `${r.theme}::${r.heading}::${r.contentHash}`;

  const rankings: Array<Map<string, number>> = [];
  const entries = new Map<string, SearchResult>();
  const bestRank = new Map<string, number>();
  for (const results of perQuery) {
    const ranking = new Map<string, number>();
    results.forEach((r, i) => {
      const key = chunkKey(r);
      const rank = i + 1;
      ranking.set(key, rank);
      if (!bestRank.has(key) || rank < bestRank.get(key)!) {
        bestRank.set(key, rank);
        entries.set(key, r);
      }
    });
    rankings.push(ranking);
  }

  const scores = fuseRankings(rankings, RRF_K);

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key], i) => ({ ...entries.get(key)!, rank: i + 1 }));
}

/**
 * Hard cap on the assembled chat context (index.md map + every included
 * theme/chunk section), in characters. ~24k chars is roughly 6k tokens —
 * generous headroom for the answer + judge call on top of even a small
 * hosted context window, while still bounding cost/latency regardless of
 * how many themes match. Never exceeded: sections are only added while
 * `used < CONTEXT_CHAR_CAP`, and a section that would push past the cap is
 * skipped rather than truncated mid-content.
 */
const CONTEXT_CHAR_CAP = 24_000;
/** Top-K chunks pulled from the hybrid index per turn — wide enough to
 *  cover a handful of themes before ranking/grouping trims it down to what
 *  actually fits under the cap. */
const CHUNK_FETCH_LIMIT = 20;
/** A theme with at least this many distinct chunk hits is treated as
 *  "strongly" relevant — worth swapping in the full page (better coherence
 *  than disjoint fragments) if it still fits under the cap. */
const MULTI_HIT_THRESHOLD = 2;

interface AssembledContext {
  /** Markdown context to inject into the system prompt (index map + theme sections). */
  context: string;
  /** Themes whose content actually contributed to `context` this turn. */
  themesConsulted: string[];
  /** False when the index (even after a rebuild) had nothing relevant — the
   *  caller should tell the model no relevant pages were found. */
  matched: boolean;
}

/** Hard-truncates text that alone exceeds a cap — unlike the per-theme
 *  sections below (which are skipped whole rather than truncated), the
 *  index map is a single unavoidable orientation section, so a huge
 *  index.md is cut down to fit rather than dropped entirely. */
function plainTruncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function loadIndexMap(vault: Vault): Promise<string> {
  try {
    return await readFile(join(vault.warmDir, "index.md"), "utf-8");
  } catch {
    return "";
  }
}

/** Joiner placed between assembled sections (see the `join()` at the end of
 *  `assembleChatContext`) — its length must be counted in `used` too, or a
 *  run of many small theme sections that each individually fit under the
 *  cap could still push the final joined string over `CONTEXT_CHAR_CAP`
 *  once every joiner between them is accounted for. */
const SECTION_JOINER = "\n\n---\n\n";

/**
 * Context assembly for chat_with_pulse: top-K chunks from the hybrid search
 * index, grouped by theme (best-first), plus the index.md page map for
 * orientation. A theme with multiple strong chunk hits is swapped for its
 * full page when that still fits under `CONTEXT_CHAR_CAP` (better
 * coherence than disjoint fragments); otherwise the chunk fragments are
 * used as-is. Themes are added in rank order until the cap is hit — later
 * themes are simply omitted, never truncated mid-section. No matches (even
 * after one rebuild+retry, see `searchChatChunks`) falls back to the
 * index.md map alone, with `matched: false` so the caller's system prompt
 * can say so instead of silently loading every theme in the vault.
 */
export async function assembleChatContext(vault: Vault, message: string): Promise<AssembledContext> {
  const indexMap = await loadIndexMap(vault);
  const chunks = await searchChatChunks(vault, message, CHUNK_FETCH_LIMIT);

  let indexSection = indexMap ? `## Wiki Index (page map)\n\n${indexMap}` : "";
  // Cap-check the index map like every other section: on a vault with a
  // huge index.md, including it uncapped could alone blow past
  // CONTEXT_CHAR_CAP before any theme section is even considered.
  if (indexSection.length > CONTEXT_CHAR_CAP) {
    indexSection = plainTruncate(indexSection, CONTEXT_CHAR_CAP);
  }

  if (chunks.length === 0) {
    return { context: indexSection, themesConsulted: [], matched: false };
  }

  const byTheme = new Map<string, SearchResult[]>();
  for (const c of chunks) {
    const list = byTheme.get(c.theme) ?? [];
    list.push(c);
    byTheme.set(c.theme, list);
  }

  const sections: string[] = [];
  const themesConsulted: string[] = [];
  let used = 0;

  if (indexSection) {
    sections.push(indexSection);
    used += indexSection.length;
  }

  for (const [theme, themeChunks] of byTheme) {
    if (used >= CONTEXT_CHAR_CAP) break;

    let section = `## ${theme}\n\n` + themeChunks.map((c) => `### ${c.heading}\n${c.snippet}`).join("\n\n");

    if (themeChunks.length >= MULTI_HIT_THRESHOLD) {
      const full = await readTheme(vault, theme);
      if (full && used + SECTION_JOINER.length + full.content.length <= CONTEXT_CHAR_CAP) {
        section = `## ${theme}\n\n${full.content}`;
      }
    }

    const addedLength = SECTION_JOINER.length + section.length;
    if (used + addedLength > CONTEXT_CHAR_CAP) continue; // doesn't fit — skip, don't truncate

    sections.push(section);
    themesConsulted.push(theme);
    used += addedLength;
  }

  return { context: sections.join(SECTION_JOINER), themesConsulted, matched: true };
}

export interface ChatWithPulseInput {
  message: string;
  sessionId?: string;
}

export interface ChatWithPulseResult {
  content: Array<{ type: "text"; text: string }>;
  sessionId: string;
}

interface JudgeResult {
  verdict: "yes" | "no" | "maybe";
  proposed_name: string | null;
  one_line_definition: string | null;
  refined_content: string | null;
}

export async function judgeAndRefine(
  provider: LlmProvider,
  model: string,
  question: string,
  answer: string,
  themesConsulted: string[],
): Promise<JudgeResult> {
  try {
    const response = await provider.complete({
      model,
      temperature: 0,
      prompt: `Question: ${question}

Answer: ${answer}

Themes consulted: ${themesConsulted.join(", ")}

Is this answer durable, reusable knowledge worth a wiki concept page, or ephemeral Q&A?

Return ONLY JSON:
{
  "verdict": "yes" | "no" | "maybe",
  "proposed_name": <kebab-case slug> | null,
  "one_line_definition": <string> | null,
  "refined_content": <full concept-page markdown with "## Definition", "## Key Claims", "## Related Concepts", "## Sources" sections> | null
}
All fields null if verdict is "no".`,
    });
    const parsed = JSON.parse(stripCodeFences(response)) as JudgeResult;
    if (!["yes", "no", "maybe"].includes(parsed.verdict)) {
      return { verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null };
    }
    return parsed;
  } catch {
    return { verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null };
  }
}

export async function handleChatWithPulse(
  vault: Vault,
  provider: LlmProvider,
  model: string,
  input: ChatWithPulseInput
): Promise<ChatWithPulseResult> {
  let session = input.sessionId ? await loadSession(vault, input.sessionId) : null;
  if (!session) session = createNewSession();

  // If the user replies "file: yes" and session has a stashed pending file (from a "maybe"
  // judge verdict on the previous turn), create the pending concept update now.
  if (/^file:\s*yes\b/i.test(input.message) && session.pendingFile) {
    const pf = session.pendingFile;
    const update: PendingUpdate = {
      id: randomUUID(),
      theme: pf.name,
      proposedContent: pf.content,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId: new Date().toISOString(),
      type: "concept",
      related: pf.themesConsulted.length > 0 ? pf.themesConsulted : undefined,
      querybackSource: { question: pf.question, themesConsulted: pf.themesConsulted },
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8",
    );
    session.pendingFile = undefined;
    const confirmText = `Filed [[${pf.name}]] as a pending concept page. Review it in the Control Center.`;
    session.messages.push({ role: "user", content: input.message });
    session.messages.push({ role: "assistant", content: confirmText });
    await saveSession(vault, session);
    return {
      content: [{ type: "text" as const, text: `${confirmText}\n\n_[session: ${session.id}]_` }],
      sessionId: session.id,
    };
  }

  // Find relevant context via the hybrid search index (top-K chunks, full
  // pages for strong multi-hit themes when they fit) — see assembleChatContext.
  const assembled = await assembleChatContext(vault, input.message);
  session.themesConsulted = [...new Set([
    ...session.themesConsulted,
    ...assembled.themesConsulted,
  ])];

  const history = session.messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  session.messages.push({ role: "user", content: input.message });

  const prompt = [
    history ? `Previous conversation:\n${history}\n\n` : "",
    `User: ${input.message}`,
  ].join("");

  const noMatchNotice = assembled.matched
    ? ""
    : " No pages in the knowledge base matched this query directly — you're only working from the page map below, so say you don't have data on this rather than guessing.";

  const systemPrompt = `You are a work assistant that helps the user understand what's happening across their projects and work activity. You have access to curated status pages (called "themes") that are maintained from automated data collection.

Answer questions based ONLY on the knowledge below. Be concise and accurate. If the knowledge doesn't contain information about something, say "I don't have data on that" rather than guessing. Never invent repository names, PR numbers, project names, dates, or any details not present below.${noMatchNotice}

${assembled.context}`;

  let response = await provider.complete({ model, prompt, systemPrompt, temperature: 0.5 });

  // Themes actually consulted in THIS turn (not cumulative across session).
  const thisCallThemes = assembled.themesConsulted;

  // Query-back: judge + refine when ≥ 2 themes consulted. Cheap LLM call decides
  // whether this answer is durable knowledge worth a concept page.
  if (thisCallThemes.length >= 2) {
    const judgment = await judgeAndRefine(provider, model, input.message, response, thisCallThemes);

    if (
      judgment.verdict === "yes" &&
      judgment.proposed_name &&
      judgment.refined_content &&
      !(await skipIfQuerybackPending(vault, sanitizeThemeSlug(judgment.proposed_name), "chat_with_pulse"))
    ) {
      const themeName = sanitizeThemeSlug(judgment.proposed_name);
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
        related: thisCallThemes,
        querybackSource: { question: input.message, themesConsulted: thisCallThemes },
      };
      await writeFile(
        join(vault.pendingDir, `${update.id}.json`),
        JSON.stringify(update, null, 2),
        "utf-8",
      );
      response += `\n\n_Filed [[${themeName}]] as a pending concept page. Review it in the Control Center._`;
    } else if (judgment.verdict === "maybe" && judgment.proposed_name && judgment.refined_content) {
      const slug = sanitizeThemeSlug(judgment.proposed_name);
      session.pendingFile = {
        name: slug,
        content: judgment.refined_content,
        question: input.message,
        themesConsulted: thisCallThemes,
      };
      response += `\n\n_This looks like durable knowledge. Reply \`file: yes\` to save as [[${slug}]]._`;
    }
    // verdict === "no": do nothing (no noise in response)
  }

  session.messages.push({ role: "assistant", content: response });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: `${response}\n\n_[session: ${session.id}]_` }],
    sessionId: session.id,
  };
}
