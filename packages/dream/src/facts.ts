import { readFile, appendFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

/**
 * Fact-store hygiene for concept/entity pages (see docs/superpowers/sdd
 * task-13 brief).
 *
 * Concept/entity pages use a two-pass flow: pass 1 extracts atomic facts
 * from new entries into `vault/warm/_facts/<theme>.jsonl`; pass 2
 * resynthesizes the page from the fact store. Left unchecked this file grows
 * duplicates forever and never signals which facts are stale. This module
 * gives every fact a stable identity (dedupe on ingest), marks stale facts
 * SUPERSEDED rather than deleting them (audit trail preserved), and archives
 * superseded facts out of the live file once it grows past a threshold
 * (never dropping content — moved, not deleted).
 */

export type FactConfidence = "high" | "medium" | "low";

export interface StoredFact {
  /** Stable identity: sha256-16 of the normalized claim text + sourceId (see computeFactId). */
  id: string;
  claim: string;
  sourceId: string;
  confidence: FactConfidence;
  extractedAt: string;
  /** Set when a later fact supersedes this one — the id of the superseding fact. Additive; the line is never deleted. */
  supersededBy?: string;
  supersededAt?: string;
}

export interface FactCandidate {
  claim: string;
  sourceId: string;
  confidence: FactConfidence;
  /** Ids of currently-active facts this candidate contradicts/updates, per the extraction prompt (see synthesize.ts). */
  supersedes?: string[];
}

export interface FactIngestResult {
  added: number;
  skipped: number;
  superseded: number;
  /** supersedes references that were dropped — self-references or ids that aren't active (or don't exist). */
  unknownSupersedeIds: string[];
}

/** Normalize fact text for identity purposes: lowercase, collapse whitespace, strip trailing punctuation. */
export function normalizeFactText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/g, "");
}

/** Stable fact identity: sha256-16 of the normalized claim text + source identifier. */
export function computeFactId(claim: string, sourceId: string): string {
  const stable = `${normalizeFactText(claim)}|${sourceId}`;
  return createHash("sha256").update(stable, "utf-8").digest("hex").slice(0, 16);
}

function isConfidence(x: unknown): x is FactConfidence {
  return x === "high" || x === "medium" || x === "low";
}

/** Parses one JSONL line, tolerating legacy lines that predate the `id`
 *  field (computed on read from claim + sourceId) and any other malformed
 *  line (skipped, not thrown). */
function parseFactLine(line: string): StoredFact | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed);
    if (!raw || typeof raw.claim !== "string" || typeof raw.sourceId !== "string") return null;
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : computeFactId(raw.claim, raw.sourceId);
    const fact: StoredFact = {
      id,
      claim: raw.claim,
      sourceId: raw.sourceId,
      confidence: isConfidence(raw.confidence) ? raw.confidence : "medium",
      extractedAt: typeof raw.extractedAt === "string" ? raw.extractedAt : new Date().toISOString(),
    };
    if (typeof raw.supersededBy === "string") fact.supersededBy = raw.supersededBy;
    if (typeof raw.supersededAt === "string") fact.supersededAt = raw.supersededAt;
    return fact;
  } catch {
    return null;
  }
}

export function parseFactsText(text: string): StoredFact[] {
  return text
    .split("\n")
    .map(parseFactLine)
    .filter((f): f is StoredFact => f !== null);
}

export function serializeFacts(facts: StoredFact[]): string {
  if (facts.length === 0) return "";
  return facts.map((f) => JSON.stringify(f)).join("\n") + "\n";
}

export async function readFactsFile(path: string): Promise<StoredFact[]> {
  try {
    const text = await readFile(path, "utf-8");
    return parseFactsText(text);
  } catch {
    return [];
  }
}

/** Facts not marked superseded — the only facts pass-2 resynthesis and compaction may read/write. */
export function activeFacts(facts: StoredFact[]): StoredFact[] {
  return facts.filter((f) => !f.supersededBy);
}

/** Atomic write: tmp file + rename, matching the ledger idiom (ledger.ts's `saveProcessedLedger`). */
export async function writeFactsAtomic(path: string, facts: StoredFact[]): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, serializeFacts(facts), "utf-8");
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/** Compact "id: claim" rendering of ACTIVE facts, for inclusion in the
 *  extraction prompt so the LLM can reference an existing fact's id in
 *  `supersedes` when a new claim contradicts/updates it. */
export function formatActiveFactsForPrompt(facts: StoredFact[]): string {
  const active = activeFacts(facts);
  if (active.length === 0) return "(none yet)";
  return active.map((f) => `${f.id}: ${f.claim}`).join("\n");
}

/**
 * Ingest new fact candidates into a theme's fact store.
 *
 * Dedupe: skips any candidate whose stable id (computeFactId) already exists
 * in the store or earlier in this same batch.
 *
 * Supersession: a candidate may list `supersedes` ids referencing currently
 * ACTIVE facts. Guards: a fact can never supersede itself (its own computed
 * id in its own `supersedes` list is ignored), and unknown/inactive ids are
 * ignored — both are reported back via `unknownSupersedeIds` for the caller
 * to log, never thrown.
 *
 * When no supersession is requested, new facts are appended without
 * rewriting existing lines (cheap, common case). When supersession IS
 * requested, the whole file is rewritten atomically (tmp+rename) since
 * existing lines need their `supersededBy`/`supersededAt` fields set —
 * lines are never deleted, only marked.
 */
export async function ingestFacts(path: string, candidates: FactCandidate[]): Promise<FactIngestResult> {
  const existingFacts = await readFactsFile(path);
  const existingIds = new Set(existingFacts.map((f) => f.id));
  const activeIds = new Set(activeFacts(existingFacts).map((f) => f.id));

  const newFacts: StoredFact[] = [];
  const supersedeEdges = new Map<string, Set<string>>();
  const unknownSupersedeIds: string[] = [];
  let skipped = 0;
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const id = computeFactId(candidate.claim, candidate.sourceId);
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }
    existingIds.add(id);

    newFacts.push({
      id,
      claim: candidate.claim,
      sourceId: candidate.sourceId,
      confidence: candidate.confidence,
      extractedAt: now,
    });

    for (const supersededId of candidate.supersedes ?? []) {
      if (supersededId === id || !activeIds.has(supersededId)) {
        unknownSupersedeIds.push(supersededId);
        continue;
      }
      const set = supersedeEdges.get(id) ?? new Set<string>();
      set.add(supersededId);
      supersedeEdges.set(id, set);
    }
  }

  if (newFacts.length === 0 && supersedeEdges.size === 0) {
    return { added: 0, skipped, superseded: 0, unknownSupersedeIds };
  }

  if (supersedeEdges.size === 0) {
    // Fast path: pure append, no need to touch existing lines.
    await appendFile(path, serializeFacts(newFacts), "utf-8");
    return { added: newFacts.length, skipped, superseded: 0, unknownSupersedeIds };
  }

  const supersededTargets = new Set<string>();
  for (const set of supersedeEdges.values()) for (const t of set) supersededTargets.add(t);

  let superseded = 0;
  const rewritten = existingFacts.map((f) => {
    if (f.supersededBy || !supersededTargets.has(f.id)) return f;
    let supersededBy = "";
    for (const [newId, targets] of supersedeEdges) {
      if (targets.has(f.id)) {
        supersededBy = newId;
        break;
      }
    }
    superseded++;
    return { ...f, supersededBy, supersededAt: now };
  });

  await writeFactsAtomic(path, [...rewritten, ...newFacts]);
  return { added: newFacts.length, skipped, superseded, unknownSupersedeIds };
}

export interface FactCompactionResult {
  archived: number;
  kept: number;
}

/**
 * Housekeeping step for concept compaction (see compact-cli.ts's
 * `compactConcept`): once a theme's live fact file grows past the
 * line/byte threshold, move superseded facts out to an append-only archive
 * file and rewrite the live file to active-only content (atomic). Content
 * is never dropped — only relocated. Returns `null` when under threshold or
 * when the live file doesn't exist (nothing to do).
 */
export async function compactFactStore(
  path: string,
  archivePath: string,
  opts: { maxLines?: number; maxBytes?: number } = {}
): Promise<FactCompactionResult | null> {
  const maxLines = opts.maxLines ?? 300;
  const maxBytes = opts.maxBytes ?? 100 * 1024;

  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  const lineCount = text.split("\n").filter((l) => l.trim().length > 0).length;
  const byteSize = Buffer.byteLength(text, "utf-8");
  if (lineCount <= maxLines && byteSize <= maxBytes) return null;

  const facts = parseFactsText(text);
  const superseded = facts.filter((f) => f.supersededBy);
  const active = facts.filter((f) => !f.supersededBy);
  if (superseded.length === 0) return null; // over threshold but nothing to move

  // Archive is append-only history — safe to append without an atomic
  // rewrite (nothing there is ever mutated, only added to).
  await appendFile(archivePath, serializeFacts(superseded), "utf-8");
  await writeFactsAtomic(path, active);

  return { archived: superseded.length, kept: active.length };
}
