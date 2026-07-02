import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Vault } from "@openpulse/core";

/**
 * Processed-entry ledger — closes the Dream Pipeline's data-loss/duplication
 * window (see docs/superpowers/specs and TODO for context):
 *
 * 1. Today's hot file is never archived (it may still be receiving appends
 *    from collectors while the pipeline runs), so re-runs must be able to
 *    recognise which of today's entries were already classified/synthesized
 *    without relying on "the file is gone" as the only signal.
 * 2. Pending updates are written to disk before the pipeline archives hot
 *    files. If the process crashes in between, the next run must not
 *    reprocess the same entries into duplicate pending updates.
 *
 * A stable, content-derived ID lets us mark individual entries "processed"
 * independent of which file they live in, and prune those markers once the
 * file that produced them is safely archived.
 */

/** Minimal shape needed to derive a stable ID — satisfied by both
 *  `ActivityEntry` and `ParsedActivityBlock`. */
export interface EntryLike {
  timestamp: string;
  log: string;
  theme?: string;
  source?: string;
}

export interface ProcessedLedgerEntry {
  processedAt: string; // ISO 8601
  batchId: string;
}

export type ProcessedLedger = Record<string, ProcessedLedgerEntry>;

function ledgerPath(vault: Vault): string {
  return join(vault.hotDir, ".processed.json");
}

/** Stable content hash (sha256, first 16 hex chars) identifying an entry
 *  regardless of which hot file it currently lives in. */
export function computeEntryId(entry: EntryLike): string {
  const stable = `${entry.timestamp}|${entry.source ?? ""}|${entry.theme ?? ""}|${entry.log}`;
  return createHash("sha256").update(stable, "utf-8").digest("hex").slice(0, 16);
}

export async function loadProcessedLedger(vault: Vault): Promise<ProcessedLedger> {
  try {
    const raw = await readFile(ledgerPath(vault), "utf-8");
    return JSON.parse(raw) as ProcessedLedger;
  } catch {
    return {};
  }
}

/** Atomic write: tmp file + rename, matching the pattern in orchestrator.ts's `saveState`. */
export async function saveProcessedLedger(vault: Vault, ledger: ProcessedLedger): Promise<void> {
  const file = ledgerPath(vault);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf-8");
  try {
    await rename(tmp, file);
  } catch (err) {
    try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Entries not yet marked processed in the ledger. */
export function filterUnprocessed<T extends EntryLike>(entries: T[], ledger: ProcessedLedger): T[] {
  return entries.filter((e) => !ledger[computeEntryId(e)]);
}

/** Returns a new ledger with the given entries marked processed under `batchId`. */
export function markProcessed<T extends EntryLike>(
  entries: T[],
  ledger: ProcessedLedger,
  batchId: string
): ProcessedLedger {
  const next = { ...ledger };
  const processedAt = new Date().toISOString();
  for (const entry of entries) {
    next[computeEntryId(entry)] = { processedAt, batchId };
  }
  return next;
}

/**
 * Removes ledger entries for the given entries (typically all entries from a
 * hot file that's about to be archived — once the file is gone there's
 * nothing left to dedupe against for those IDs, so keeping them would only
 * grow the ledger forever). Returns the same object reference when nothing
 * changed, so callers can cheaply detect whether a save is needed.
 */
export function pruneLedgerForEntries<T extends EntryLike>(
  entries: T[],
  ledger: ProcessedLedger
): ProcessedLedger {
  let changed = false;
  const next = { ...ledger };
  for (const entry of entries) {
    const id = computeEntryId(entry);
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : ledger;
}
