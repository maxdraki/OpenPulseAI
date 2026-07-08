/**
 * Aigis rollup submission — the "submit on approval" half of the Aigis
 * integration (see `packages/core/src/aigis/client.ts` for the outbound MCP
 * client + config, and `.superpowers/sdd/task-17-brief.md` for the full
 * spec). Kept out of `approve.ts`'s write-dispatch switch so the arg-mapping
 * and `submissions.jsonl` bookkeeping are separately testable, near-pure
 * functions — per the brief's "make the arg-mapping a small pure function so
 * it's easy to adjust" requirement.
 *
 * Posture, mirroring `callAigisTool`: nothing here throws to a caller that
 * didn't opt in. A submission failure must never fail the approval it's
 * attached to (see `approve.ts`'s `aigisRollup` branch) — it's recorded as
 * `ok: false` in `submissions.jsonl` and surfaced to the UI instead.
 */
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { callAigisTool, loadConfig, DEFAULT_AIGIS_SUBMIT_TOOL, isSafeThemeName, type AigisConfig, Vault } from "@openpulse/core";

/** Injectable seam for `callAigisTool` — production callers never set this;
 *  tests substitute a fake to avoid a real MCP connection (see brief's "mock
 *  callAigisTool at module boundary" — this is the module boundary here). */
export type CallAigisToolFn = typeof callAigisTool;

/**
 * On-disk shape of a line in `vault/aigis/submissions.jsonl`. Mirrors core's
 * `AigisSubmissionRecord` (updateId/submittedAt/ok/error/toolName) plus the
 * theme/period fields this module needs to locate the submitted content and
 * rebuild the submit args on retry. Kept local to the ui package rather than
 * widening the core type — out of this task's core-package scope (see brief:
 * "packages/core ONLY for vault.ts's aigis dir accessor").
 */
export interface AigisSubmissionRecord {
  updateId: string;
  theme: string;
  periodStart: string;
  periodEnd: string;
  submittedAt: string; // ISO 8601
  ok: boolean;
  error?: string;
  toolName: string;
  /** True when this record represents a skipped (Aigis not connected/enabled)
   *  attempt rather than a real network/tool failure (fix round 1 #2) — lets
   *  displays distinguish "skipped" from "failed" instead of conflating both
   *  into `ok: false`. */
  skipped?: boolean;
}

export interface AigisSubmissionOutcome {
  ok: boolean;
  error?: string;
  /** True when no network call was attempted because Aigis isn't
   *  connected/enabled — distinct from a real submission failure. */
  skipped?: boolean;
}

/** Path of the approved rollup content for `theme` — inside `vault/aigis/`,
 *  never `vault/warm/` (must not pollute the wiki/index/search). */
export function aigisThemeFilePath(vault: Vault, theme: string): string {
  return join(vault.aigisDir, `${theme}.md`);
}

function submissionsLogPath(vault: Vault): string {
  return join(vault.aigisDir, "submissions.jsonl");
}

/**
 * Maps an approved rollup's content + period into the payload sent to the
 * configured Aigis submit tool. The session-visible shape of
 * aigis_submit_journal-like tools is unknown, so this sends a conservative,
 * self-describing payload — its own pure function so the mapping is easy to
 * adjust later without touching the submit/record plumbing around it.
 */
export function buildAigisSubmitArgs(content: string, periodStart: string, periodEnd: string): Record<string, unknown> {
  // The `aigis_submit_journal` tool requires a single `params` object holding
  // a `JournalInput` — `content` (required) plus an optional human-readable
  // `period` (NOT the two raw ISO timestamps). Sending `{journal, period_start,
  // period_end, source}` at the top level is rejected with a Pydantic
  // "params field required" validation error. See the tool's inputSchema.
  return {
    params: {
      content,
      period: `${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`,
    },
  };
}

/** Appends one outcome line to `vault/aigis/submissions.jsonl` — atomic
 *  append, creates the file/dir on first use. */
export async function appendAigisSubmissionRecord(vault: Vault, record: AigisSubmissionRecord): Promise<void> {
  await mkdir(vault.aigisDir, { recursive: true });
  await appendFile(submissionsLogPath(vault), `${JSON.stringify(record)}\n`, "utf-8");
}

/** Finds the most recent `submissions.jsonl` record for `updateId` (last
 *  matching line wins — a resubmit appends a new record rather than
 *  rewriting history), or `undefined` if none exists / the log is missing. */
export async function findAigisSubmissionRecord(vault: Vault, updateId: string): Promise<AigisSubmissionRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(submissionsLogPath(vault), "utf-8");
  } catch {
    return undefined;
  }
  let found: AigisSubmissionRecord | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as AigisSubmissionRecord;
      if (record.updateId === updateId) found = record;
    } catch {
      // Malformed line — skip it rather than fail the whole read.
    }
  }
  return found;
}

/**
 * Submits an approved rollup's content to Aigis via the configured MCP
 * connection, and always appends an outcome record to `submissions.jsonl` —
 * for success, failure, AND the "not connected" skip case. Never throws.
 */
export async function submitAigisRollup(
  vault: Vault,
  config: AigisConfig | undefined,
  updateId: string,
  theme: string,
  content: string,
  periodStart: string,
  periodEnd: string,
  callTool: CallAigisToolFn = callAigisTool
): Promise<AigisSubmissionOutcome> {
  const toolName = config?.submitTool || DEFAULT_AIGIS_SUBMIT_TOOL;

  if (!config?.enabled) {
    await appendAigisSubmissionRecord(vault, {
      updateId,
      theme,
      periodStart,
      periodEnd,
      toolName,
      submittedAt: new Date().toISOString(),
      ok: false,
      error: "skipped: not connected",
      skipped: true,
    });
    return { ok: false, error: "skipped: not connected", skipped: true };
  }

  const args = buildAigisSubmitArgs(content, periodStart, periodEnd);

  // Fix round 1 (#4): append a "pending" record BEFORE the outbound call,
  // not just after. The theme's content file is written to vault/aigis/ and
  // the pending update removed *before* this function ever runs (see
  // approve.ts) — if the process crashes during the network call below (the
  // one step here with unbounded duration), a record-less crash window would
  // otherwise leave `resubmitAigisRollup` unable to find the theme/period for
  // this updateId and 404 forever. `findAigisSubmissionRecord` always returns
  // the LAST matching line, so the real outcome appended below simply
  // supersedes this one on the happy path.
  await appendAigisSubmissionRecord(vault, {
    updateId,
    theme,
    periodStart,
    periodEnd,
    toolName,
    submittedAt: new Date().toISOString(),
    ok: false,
    error: "Aigis submission in progress",
  });

  const result = await callTool(config, toolName, args);

  await appendAigisSubmissionRecord(vault, {
    updateId,
    theme,
    periodStart,
    periodEnd,
    toolName,
    submittedAt: new Date().toISOString(),
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error ?? "Aigis submission failed" }),
  });

  return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Aigis submission failed" };
}

export interface ResubmitOutcome {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Retries a previously failed/skipped Aigis submission for `updateId` —
 * looks up the prior record (for theme + period), re-reads the content
 * `approve()` already wrote to `vault/aigis/<theme>.md`, and resubmits.
 * Backs `POST /api/aigis-resubmit/:updateId`.
 */
export async function resubmitAigisRollup(
  vaultRoot: string,
  updateId: string,
  callTool: CallAigisToolFn = callAigisTool
): Promise<ResubmitOutcome> {
  const vault = new Vault(vaultRoot);
  await vault.init();

  const record = await findAigisSubmissionRecord(vault, updateId);
  if (!record) return { ok: false, status: 404, error: "No prior Aigis submission found for this update" };

  // Fix round 1 (#3): defense-in-depth. `record.theme` is safe transitively
  // today (approve.ts validates it before ever writing a submissions.jsonl
  // record), but this function builds a filesystem path from it directly —
  // re-validate here rather than relying on an invariant upheld elsewhere.
  if (!isSafeThemeName(record.theme)) {
    return { ok: false, status: 400, error: `Unsafe theme name in submission record: "${record.theme}"` };
  }

  let content: string;
  try {
    content = await readFile(aigisThemeFilePath(vault, record.theme), "utf-8");
  } catch {
    return { ok: false, status: 404, error: `Aigis content file missing for theme "${record.theme}"` };
  }

  const config = await loadConfig(vaultRoot);
  const outcome = await submitAigisRollup(
    vault,
    config.aigis,
    updateId,
    record.theme,
    content,
    record.periodStart,
    record.periodEnd,
    callTool
  );

  if (!outcome.ok) return { ok: false, status: 502, error: outcome.error };
  return { ok: true, status: 200 };
}
