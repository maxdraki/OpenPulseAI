import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type Vault,
  type LlmProvider,
  type PendingUpdate,
  type ActivityEntry,
  vaultLog,
  vaultLogSince,
  parseActivityBlocks,
  readTheme,
  stripCodeFences,
} from "@openpulse/core";
import { acquireDreamLock } from "./lock.js";

/** Total character budget across journal entries + theme excerpts fed into
 *  the rollup prompt — keeps a long weekly/monthly window from blowing past
 *  the model's context window. Journal entries are included first (they're
 *  the most concrete evidence); whatever budget remains goes to theme
 *  excerpts, prioritized by how many commits touched each theme. */
const MAX_INPUT_CHARS = 40_000;

const DEFAULT_LOOKBACK_MS: Record<"weekly" | "monthly", number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export interface RollupPeriod {
  periodStart: string; // ISO 8601
  periodEnd: string;   // ISO 8601
}

/**
 * Determines the rollup window: from the pipeline's last successful run (or
 * `now - cadence` when it has never run) to `now`. Pure function so the
 * period-selection logic is independently testable from I/O.
 */
export function computeRollupPeriod(
  cadence: "weekly" | "monthly",
  lastRun: string | null,
  now: Date = new Date()
): RollupPeriod {
  const periodEnd = now.toISOString();
  const periodStart = lastRun ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS[cadence]).toISOString();
  return { periodStart, periodEnd };
}

export interface ThemeExcerpt {
  theme: string;
  content: string;
}

export interface RollupInputs {
  commitSubjects: string[];
  /** Warm theme names touched in the period, ordered by change frequency (most-changed first). */
  themesTouched: string[];
  journalEntries: ActivityEntry[];
  /** Current content of the most relevant touched themes, truncated to fit `MAX_INPUT_CHARS`. */
  themeExcerpts: ThemeExcerpt[];
  /** True when there is anything at all to draft from (a commit or a journal entry) — an empty
   *  period must produce no pending update rather than an LLM call over nothing. */
  hasActivity: boolean;
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const COLD_MONTH_RE = /^\d{4}-\d{2}$/;

/** Reads and parses activity blocks from every daily file in `dir` matching `YYYY-MM-DD.md`,
 *  filtering to entries whose timestamp falls within [startMs, endMs]. Read-only, tolerant of
 *  a missing directory or unreadable file (skips, never throws). */
async function collectEntriesFromDir(dir: string, startMs: number, endMs: number): Promise<ActivityEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const entries: ActivityEntry[] = [];
  for (const file of files) {
    if (!DATE_FILE_RE.test(file)) continue;
    try {
      const content = await readFile(join(dir, file), "utf-8");
      for (const block of parseActivityBlocks(content)) {
        const ts = Date.parse(block.timestamp);
        if (!Number.isFinite(ts) || ts < startMs || ts > endMs) continue;
        entries.push({ timestamp: block.timestamp, log: block.log, theme: block.theme, source: block.source });
      }
    } catch {
      // Unreadable file — skip, matching the graceful-degradation convention
      // used throughout the dream pipeline's readers.
    }
  }
  return entries;
}

/** Reads journal entries (hot + cold archives) whose timestamp falls inside [periodStart, periodEnd]. */
export async function readJournalEntriesInWindow(
  vault: Vault,
  periodStart: string,
  periodEnd: string
): Promise<ActivityEntry[]> {
  const startMs = Date.parse(periodStart);
  const endMs = Date.parse(periodEnd);

  const entries = await collectEntriesFromDir(vault.hotDir, startMs, endMs);

  try {
    const months = await readdir(vault.coldDir);
    for (const month of months) {
      if (!COLD_MONTH_RE.test(month)) continue;
      entries.push(...(await collectEntriesFromDir(join(vault.coldDir, month), startMs, endMs)));
    }
  } catch {
    // No cold dir yet — fine, nothing archived.
  }

  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
}

/**
 * Gathers everything the rollup prompt needs: vault git history for the
 * window, journal entries in the window, and current content of the themes
 * that history touched (prioritized by change count, capped at
 * `MAX_INPUT_CHARS` total so a long window can't blow the model's context).
 * Entirely read-only.
 */
export async function gatherRollupInputs(
  vault: Vault,
  periodStart: string,
  periodEnd: string
): Promise<RollupInputs> {
  const commits = await vaultLogSince(vault, periodStart);
  const commitSubjects = commits.map((c) => c.subject);

  const themeCounts = new Map<string, number>();
  for (const commit of commits) {
    for (const theme of commit.themes) {
      themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    }
  }
  const themesTouched = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([theme]) => theme);

  const journalEntries = await readJournalEntriesInWindow(vault, periodStart, periodEnd);

  const journalChars = journalEntries.reduce((sum, e) => sum + e.log.length, 0);
  let budget = MAX_INPUT_CHARS - journalChars;

  const themeExcerpts: ThemeExcerpt[] = [];
  for (const theme of themesTouched) {
    if (budget <= 0) break;
    const doc = await readTheme(vault, theme);
    if (!doc) continue;
    const content = doc.content.slice(0, Math.max(0, budget));
    if (content.length === 0) continue;
    themeExcerpts.push({ theme, content });
    budget -= content.length;
  }

  return {
    commitSubjects,
    themesTouched,
    journalEntries,
    themeExcerpts,
    hasActivity: commits.length > 0 || journalEntries.length > 0,
  };
}

/**
 * Builds the LLM prompt for the rollup draft. Anti-hallucination framing
 * mirrors synthesize.ts's PATCH_SYSTEM_PROMPT: only claims backed by the
 * supplied inputs, prefer quoting concrete artifacts verbatim. First-person,
 * professional tone — this update represents the user to aigis.bio.
 */
export function buildAigisRollupPrompt(
  inputs: RollupInputs,
  periodStart: string,
  periodEnd: string,
  cadence: "weekly" | "monthly"
): string {
  const commitsText = inputs.commitSubjects.length > 0
    ? inputs.commitSubjects.map((s) => `- ${s}`).join("\n")
    : "(none)";

  const entriesText = inputs.journalEntries.length > 0
    ? inputs.journalEntries
        .map((e) => `### ${e.timestamp}${e.source ? ` (${e.source})` : ""}\n${e.log}`)
        .join("\n\n")
    : "(none)";

  const themesText = inputs.themeExcerpts.length > 0
    ? inputs.themeExcerpts.map((t) => `#### ${t.theme}\n${t.content}`).join("\n\n")
    : "(none)";

  return `You are drafting a candidate-relevant journal update to submit to aigis.bio, a service that maintains a verified professional knowledge store on behalf of the user. Write in the FIRST PERSON, as the user, in a professional tone suitable for representing this work to a prospective employer or evaluator.

Rollup period: ${periodStart} to ${periodEnd} (${cadence} cadence).

You MUST only include information that is explicitly present in the inputs below. NEVER invent, fabricate, or hallucinate any data including repository names, PR/issue titles, people's names, dates, metrics, or outcomes. Prefer quoting concrete artifacts verbatim — repo names, PR/commit titles, theme names — over paraphrasing. If the inputs don't support a section, omit that section or state briefly that there is nothing to report; do not pad with generic filler.

## Vault commit history for this period
${commitsText}

## Journal entries for this period
${entriesText}

## Warm theme pages touched this period (current content, for context)
${themesText}

Produce a Markdown journal update with these sections, in this order:
## Summary
## Skills Demonstrated
## Artifacts & Outcomes
## Decisions & Rationale
## Collaboration & Reviews (optional — omit this entire section if the inputs have nothing to support it)

Return ONLY the Markdown content. No code fences, no commentary before or after.`;
}

/** Derives the pending update's theme name from the period end date — this
 *  doubles as the "same period" identity used to fold repeated drafts (see
 *  `replaceExistingRollupPending`): two runs landing on the same calendar day
 *  represent the same rollup period even if their exact `periodStart`/
 *  `periodEnd` timestamps differ by seconds (e.g. a retried or manually
 *  re-triggered run). */
function rollupThemeName(periodEnd: string): string {
  return `aigis-rollup-${periodEnd.slice(0, 10)}`;
}

function buildAigisRollupUpdate(
  periodStart: string,
  periodEnd: string,
  cadence: "weekly" | "monthly",
  proposedContent: string
): PendingUpdate {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    theme: rollupThemeName(periodEnd),
    proposedContent,
    previousContent: null,
    entries: [],
    createdAt: now,
    status: "pending",
    batchId: now,
    aigisRollup: { periodStart, periodEnd, cadence },
  };
}

/** Removes any existing pending update for the same rollup period (see `rollupThemeName`) —
 *  a fold, not a stack: re-running the pipeline for a period that already has a draft replaces
 *  it rather than piling up duplicates. Tolerates unreadable/corrupt pending files by skipping them. */
async function replaceExistingRollupPending(vault: Vault, periodEnd: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(vault.pendingDir);
  } catch {
    return;
  }

  const theme = rollupThemeName(periodEnd);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(vault.pendingDir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as PendingUpdate;
      if (parsed.aigisRollup && parsed.theme === theme) {
        await unlink(filePath);
      }
    } catch {
      // Corrupt/unreadable pending file — leave it, not this pipeline's job to clean up.
    }
  }
}

export interface RunAigisRollupOptions {
  cadence: "weekly" | "monthly";
  /** Previous successful run's timestamp (orchestrator-owned
   *  `aigisRollupPipeline.lastRun`), or `null` if it has never run. */
  lastRun: string | null;
  now?: Date; // injectable for tests; defaults to `new Date()`
}

/**
 * Runs the Aigis rollup pipeline against an already-initialized vault:
 * computes the period from `opts.lastRun`/`opts.cadence` (or falls back to
 * `now - cadence` when never run), gathers read-only inputs (vault git log,
 * journal entries, touched theme content), and — only if the window has any
 * activity at all — drafts ONE pending update via the LLM and writes it to
 * the review queue. Never touches warm/ and never submits anywhere; that's a
 * separate, approval-gated step.
 *
 * Acquires the dream lock like `runCompaction` does (see compact-cli.ts):
 * reading warm theme content concurrently with a dream/compaction run that's
 * rewriting those same files could see a torn read, and this pipeline has no
 * reason to run at the exact same instant as either of those.
 */
export async function runAigisRollup(
  vault: Vault,
  provider: LlmProvider,
  model: string,
  opts: RunAigisRollupOptions
): Promise<boolean> {
  const releaseLock = await acquireDreamLock(vault);
  try {
    const { cadence } = opts;
    const { periodStart, periodEnd } = computeRollupPeriod(cadence, opts.lastRun, opts.now);

    const inputs = await gatherRollupInputs(vault, periodStart, periodEnd);
    if (!inputs.hasActivity) {
      await vaultLog("info", `[aigis-rollup] No activity in period ${periodStart}..${periodEnd} — skipping`);
      return false;
    }

    const prompt = buildAigisRollupPrompt(inputs, periodStart, periodEnd, cadence);
    const response = await provider.complete({ model, temperature: 0.2, maxTokens: 3072, prompt });
    const content = stripCodeFences(response).trim();

    await replaceExistingRollupPending(vault, periodEnd);
    const update = buildAigisRollupUpdate(periodStart, periodEnd, cadence, content);
    await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");

    await vaultLog("info", `[aigis-rollup] Drafted rollup pending update for ${periodStart}..${periodEnd}`);
    return true;
  } finally {
    await releaseLock();
  }
}
