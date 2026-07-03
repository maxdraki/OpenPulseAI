/**
 * Approve/regenerate logic for pending wiki updates — extracted out of
 * `server.ts` so it's directly unit-testable (no express app, no listening
 * port, no orchestrator side effects). See `.superpowers/sdd/task-4-brief.md`
 * for the conflict-detection requirements this implements.
 *
 * A pending update's `proposedContent` was synthesized against the theme's
 * on-disk content at `previousContent`-snapshot time. Before writing on
 * approve, we compare the current on-disk page against that snapshot — if
 * they differ, something else changed the page in the meantime (another
 * Dream run, a compaction/lint fix, or a hand-edit) and approving would
 * silently discard it. See `checkStaleness` in `@openpulse/core`.
 *
 * This module is server-side (Node fs) only — it is never imported by any
 * browser page, so it's safe to live under `src/lib/` alongside browser-only
 * modules without affecting the Vite bundle (tree-shaken when unreferenced).
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  Vault,
  writeTheme,
  readTheme,
  mergeThemes,
  isSafeThemeName,
  checkStaleness,
  commitVault,
  updateThemeInIndex,
  removeThemeFromIndex,
  rebuildIndex,
  type PendingUpdate,
  type LlmProvider,
} from "../../../core/dist/index.js";
import { regenerateStaleUpdate } from "../../../dream/dist/synthesize.js";

export interface ApproveSuccess {
  ok: true;
  theme: string;
  finalContent: string;
  update: PendingUpdate;
}

export interface ApproveFailure {
  ok: false;
  status: number;
  error: string;
  /** Set when the failure is specifically a staleness conflict (409). */
  stale?: boolean;
  theme?: string;
  reason?: string;
}

export type ApproveOutcome = ApproveSuccess | ApproveFailure;

/**
 * Builds the vault-git commit message for an approved update — structural
 * lintFix kinds (merge/rename/delete) get a message that names the
 * source/canonical themes involved, everything else gets a generic
 * `approve(<theme>): <kind> batch=<batchId>` (see task-5 brief §B).
 */
/**
 * Keeps the local search index in sync with a write this approve just made
 * — structural lintFix kinds (merge/rename/delete) rewrite the wiki graph
 * (see `mergeThemes`), so the source theme's chunks are removed and the
 * canonical theme's are re-indexed; a normal content write re-indexes just
 * that theme. `_schema.md` isn't a warm theme page, so it's never indexed.
 * Never throws — an index hiccup here must never turn an otherwise-
 * successful approve into a failure (updateThemeInIndex/removeThemeFromIndex
 * already degrade gracefully on their own, but this is belt-and-braces).
 *
 * merge/rename are handled with a full `rebuildIndex` rather than a
 * targeted removeThemeFromIndex/updateThemeInIndex pair: `mergeThemes`
 * rewrites `[[wiki-links]]` in every OTHER warm file that referenced the
 * source theme (see `mergeThemes`'s link-rewrite pass), not just the
 * source/canonical pair, so a targeted update leaves those third-party
 * files' index entries stale (still indexed under their old link text).
 * A full rebuild is the cheapest fix that's still correct — still swallowed
 * on error, so it can never turn a successful approve into a failure.
 */
async function syncSearchIndex(vault: Vault, update: PendingUpdate, related0: string | undefined): Promise<void> {
  try {
    if (update.lintFix === "merge" || update.lintFix === "rename") {
      await rebuildIndex(vault);
    } else if (update.lintFix === "delete") {
      await removeThemeFromIndex(vault, update.theme);
    } else if (update.schemaEvolution || update.theme === "_schema") {
      // _schema.md is not a warm theme page — not part of the search index.
    } else {
      await updateThemeInIndex(vault, update.theme);
    }
  } catch {
    // Swallow — see doc comment above.
  }
}

function commitMessageForApprove(update: PendingUpdate, related0: string | undefined): string {
  const batch = update.batchId ?? update.id;
  if (update.lintFix === "merge" && related0) return `merge(${update.theme}->${related0}) batch=${batch}`;
  if (update.lintFix === "rename" && related0) return `rename(${update.theme}->${related0}) batch=${batch}`;
  if (update.lintFix === "delete") return `delete(${update.theme}) batch=${batch}`;
  if (update.schemaEvolution || update.theme === "_schema") return `approve(_schema): schema batch=${batch}`;
  if (update.compactionType) return `approve(${update.theme}): compaction-${update.compactionType} batch=${batch}`;
  if (update.querybackSource) return `approve(${update.theme}): queryback batch=${batch}`;
  if (update.lintFix) return `approve(${update.theme}): lint-${update.lintFix} batch=${batch}`;
  return `approve(${update.theme}): update batch=${batch}`;
}

/**
 * Reads the current on-disk content that a pending update's theme would
 * overwrite, for staleness comparison. Mirrors the write dispatch below:
 * schema pendings compare against `_schema.md`, normal/lint-content pendings
 * compare against the theme's warm page. Structural lintFix kinds (merge/
 * delete/rename) don't carry a meaningful content snapshot to compare (their
 * `previousContent` is always `null` by construction) and are exempted —
 * see `isStructuralLintFix`.
 */
export async function readCurrentContentForUpdate(vault: Vault, update: PendingUpdate): Promise<string | null> {
  if (update.schemaEvolution || update.theme === "_schema") {
    try {
      return await readFile(join(vault.warmDir, "_schema.md"), "utf-8");
    } catch {
      return null;
    }
  }
  const doc = await readTheme(vault, update.theme);
  return doc?.content ?? null;
}

/** Structural lintFix kinds rewrite the wiki graph rather than a single
 *  page's content — their pendings never carry a comparable snapshot. */
export function isStructuralLintFix(update: Pick<PendingUpdate, "lintFix">): boolean {
  return update.lintFix === "merge" || update.lintFix === "delete" || update.lintFix === "rename";
}

export interface StalenessGateResult {
  proceed: boolean;
  stale: boolean;
  legacy: boolean;
}

/** Pure staleness gate — given a pending update's `previousContent` and the
 *  page's current on-disk content, decide whether the write may proceed. */
export function gateOnStaleness(
  previousContent: string | null | undefined,
  currentContent: string | null | undefined
): StalenessGateResult {
  const { stale, legacy } = checkStaleness(previousContent, currentContent);
  return { proceed: !stale, stale, legacy };
}

/**
 * Full approve flow: read the pending file, validate theme names, gate on
 * staleness (skipped for structural lintFix kinds), dispatch the write
 * (merge/delete/rename via `mergeThemes`, schema via `_schema.md`, everything
 * else via `writeTheme`), and remove the pending file on success.
 *
 * Callers (server.ts) are responsible for side effects outside this module's
 * scope: triggering the background index/backlinks rebuild and enqueueing
 * compaction for oversized project pages — both need the live orchestrator
 * instance, not available here.
 */
export interface ApprovePendingUpdateOpts {
  /** When false, the write still happens but the audit commit is skipped —
   *  used by `approvePendingUpdatesBatch` so a whole "Approve All" action
   *  lands as a single commit listing every theme, instead of one commit
   *  per item (see task-5 brief §B). Defaults to true. */
  commit?: boolean;
}

export async function approvePendingUpdate(
  vaultRoot: string,
  pendingDir: string,
  id: string,
  editedContent: string | undefined,
  opts: ApprovePendingUpdateOpts = {}
): Promise<ApproveOutcome> {
  const pendingPath = join(pendingDir, `${id}.json`);
  let update: PendingUpdate;
  try {
    const raw = await readFile(pendingPath, "utf-8");
    update = JSON.parse(raw) as PendingUpdate;
  } catch (e: unknown) {
    // Missing/unreadable pending file is a 404 (like `regeneratePendingUpdate`
    // below), not a 500 — it's an expected "already approved/rejected/gone by
    // someone else" race, not a server error (M6).
    return { ok: false, status: 404, error: e instanceof Error ? e.message : String(e) };
  }

  const finalContent = editedContent ?? update.proposedContent;

  if (update.theme !== "_schema" && !isSafeThemeName(update.theme)) {
    return { ok: false, status: 400, error: "Unsafe theme name in pending update" };
  }
  const related: string[] = Array.isArray(update.related) ? update.related : [];
  if (related[0] && !isSafeThemeName(related[0])) {
    return { ok: false, status: 400, error: "Unsafe related theme name" };
  }

  const vault = new Vault(vaultRoot);
  await vault.init();

  if (!isStructuralLintFix(update)) {
    const currentContent = await readCurrentContentForUpdate(vault, update);
    const gate = gateOnStaleness(update.previousContent, currentContent);
    if (gate.legacy) {
      console.warn(`[server] approve: pending "${id}" has no previousContent snapshot (legacy record) — allowing without a staleness check.`);
    }
    if (!gate.proceed) {
      const reason = `The page for "${update.theme}" changed since this update was proposed.`;
      return { ok: false, status: 409, error: "stale", stale: true, theme: update.theme, reason };
    }
  }

  try {
    if (update.lintFix === "merge" && related[0]) {
      await mergeThemes(vault, update.theme, related[0]);
    } else if (update.lintFix === "delete") {
      await mergeThemes(vault, update.theme, null);
    } else if (update.lintFix === "rename" && related[0]) {
      await mergeThemes(vault, update.theme, related[0], { rename: true });
    } else if (update.schemaEvolution || update.theme === "_schema") {
      await writeFile(join(vault.warmDir, "_schema.md"), finalContent, "utf-8");
    } else {
      await writeTheme(vault, update.theme, finalContent, {
        type: update.type,
        sources: update.sources,
        related: update.related,
        created: update.created,
        skills: update.skills,
        status: update.projectStatus,
        statusReason: update.projectStatusReason,
      });
    }

    await rm(pendingPath);

    // Keep the search index fresh so an approved page/merge/rename/delete is
    // searchable immediately, without ever failing an otherwise-successful
    // approve if the index update itself hiccups (see syncSearchIndex below).
    await syncSearchIndex(vault, update, related[0]);

    if (opts.commit !== false) {
      // Fire-and-forget audit commit — commitVault never throws (see
      // vault-git.ts), so a missing/broken git binary can never fail approval.
      await commitVault(vault, commitMessageForApprove(update, related[0]));
    }

    return { ok: true, theme: update.theme, finalContent, update };
  } catch (e: unknown) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface BatchApproveResultEntry {
  id: string;
  outcome: ApproveOutcome;
}

/**
 * Approves a whole "Approve All" batch (see task-5 brief §B: "a batch
 * approve = one commit listing themes"). Runs each item through the same
 * gate/write/staleness logic as `approvePendingUpdate` (sequentially, so the
 * final commit deterministically reflects everything written), but defers
 * the audit commit until every item has been processed, then makes exactly
 * ONE commit naming every theme that was actually written — instead of one
 * commit per item. Items that fail (stale conflict or otherwise) are simply
 * omitted from that commit message and reported back per-id so the caller
 * (server.ts / the Review UI) can surface stale/failed counts exactly as
 * before.
 */
export async function approvePendingUpdatesBatch(
  vaultRoot: string,
  pendingDir: string,
  ids: string[]
): Promise<BatchApproveResultEntry[]> {
  const results: BatchApproveResultEntry[] = [];
  const committedThemes: string[] = [];
  let batchId: string | undefined;

  for (const id of ids) {
    const outcome = await approvePendingUpdate(vaultRoot, pendingDir, id, undefined, { commit: false });
    results.push({ id, outcome });
    if (outcome.ok) {
      committedThemes.push(outcome.theme);
      batchId ??= outcome.update.batchId;
    }
  }

  if (committedThemes.length > 0) {
    const vault = new Vault(vaultRoot);
    await vault.init();
    const label = batchId ?? "manual";
    await commitVault(vault, `approve(batch): ${committedThemes.join(", ")} batch=${label}`);
  }

  return results;
}

export interface RegenerateSuccess {
  ok: true;
  update: PendingUpdate;
}

export interface RegenerateFailure {
  ok: false;
  status: number;
  error: string;
}

export type RegenerateOutcome = RegenerateSuccess | RegenerateFailure;

/**
 * Produces a replacement pending update for a stale one — merges the stale
 * proposal's new information onto the CURRENT on-disk page via the LLM (see
 * `regenerateStaleUpdate` in `@openpulse/dream`), writes it in place of the
 * stale pending, and returns it so the caller (server.ts's
 * `POST /api/pending/:id/regenerate`) can hand it back to the Review UI.
 *
 * `provider`/`model` are always caller-supplied (not loaded from config
 * here) so tests can inject a mock provider without touching real LLM
 * config/credentials.
 */
export async function regeneratePendingUpdate(
  vaultRoot: string,
  pendingDir: string,
  id: string,
  provider: LlmProvider,
  model: string
): Promise<RegenerateOutcome> {
  const pendingPath = join(pendingDir, `${id}.json`);
  let update: PendingUpdate;
  try {
    const raw = await readFile(pendingPath, "utf-8");
    update = JSON.parse(raw) as PendingUpdate;
  } catch (e: unknown) {
    return { ok: false, status: 404, error: e instanceof Error ? e.message : String(e) };
  }

  const vault = new Vault(vaultRoot);
  await vault.init();

  try {
    const currentContent = await readCurrentContentForUpdate(vault, update);
    const replacement = await regenerateStaleUpdate(vault, update, currentContent, provider, model);
    return { ok: true, update: replacement };
  } catch (e: unknown) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}
