#!/usr/bin/env node
/**
 * openpulse-lint — Wiki lint CLI entry point
 *
 * Default run writes _lint.md AND proposes pending updates for every
 * fixable category (stubs, orphans, merges, low-value deletions).
 * Pass --fix=X to restrict to a single category, or --no-fix for
 * report-only mode.
 *
 * Usage:
 *   openpulse-lint                         # analyse + auto-propose all fixes
 *   openpulse-lint --no-fix                # analyse only, no pending updates
 *   openpulse-lint --fix=stubs             # analyse + only stub fixes
 *   openpulse-lint --fix=orphans           # analyse + only orphan-candidate fixes (classify)
 *   openpulse-lint --fix=empty-orphans     # analyse + only delete empty orphan pages
 *   openpulse-lint --fix=merge             # analyse + only merge proposals
 *   openpulse-lint --fix=delete-lowvalue   # analyse + only low-value deletions
 *   openpulse-lint --fix=broken-links      # analyse + only broken-link rewrites
 *   openpulse-lint --fix=dedup-dates       # analyse + only duplicate-date dedup
 *   openpulse-lint --fix=rename --from=X --to=Y   # explicit rename
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Vault,
  loadConfig,
  createProvider,
  initLogger,
  vaultLog,
  listThemes,
  readTheme,
  sanitizeThemeSlug,
  stripCodeFences,
  type LlmProvider,
} from "@openpulse/core";
import { runStructuralChecks, type StructuralIssue } from "./lint-structural.js";
import { findStubCandidates, findContradictions, type SemanticIssue } from "./lint-semantic.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const fixFlag = process.argv.find((a) => a.startsWith("--fix="))?.split("=")[1] as
  | "stubs"
  | "orphans"
  | "merge"
  | "delete-lowvalue"
  | "rename"
  | "broken-links"
  | "dedup-dates"
  | "empty-orphans"
  | undefined;

// ---------------------------------------------------------------------------
// Type label mapping
// ---------------------------------------------------------------------------
const TYPE_LABELS: Record<StructuralIssue["type"], string> = {
  "broken-link": "Broken cross-references",
  orphan: "Orphan themes",
  "schema-noncompliant": "Schema compliance issues",
  stale: "Stale themes",
  "duplicate-date": "Duplicate dated sections",
  "low-value": "Low-value pages",
  "duplicate-theme": "Near-duplicate themes",
  "low-provenance": "Low-provenance pages",
};

// ---------------------------------------------------------------------------
// writeLintReport
// ---------------------------------------------------------------------------
async function writeLintReport(
  vault: Vault,
  structural: StructuralIssue[],
  stubs: SemanticIssue[],
  contradictions: SemanticIssue[],
  themeCount: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const totalIssues = structural.length + stubs.length + contradictions.length;

  const lines: string[] = [];
  lines.push(`# Wiki Lint — ${today}`);

  // Track candidate-file summaries so the Actions footer knows whether to
  // advertise the corresponding --fix modes.
  let hasOrphanCandidates = false;
  let hasConceptCandidates = false;

  if (totalIssues === 0) {
    lines.push(``, `✓ All ${themeCount} themes look healthy.`);
  } else {
    // Group structural issues by type
    const byType = new Map<StructuralIssue["type"], StructuralIssue[]>();
    for (const issue of structural) {
      const group = byType.get(issue.type) ?? [];
      group.push(issue);
      byType.set(issue.type, group);
    }

    // Emit a section for each structural type that has issues
    const orderedTypes: StructuralIssue["type"][] = [
      "broken-link",
      "orphan",
      "schema-noncompliant",
      "stale",
      "duplicate-date",
      "low-value",
      "duplicate-theme",
      "low-provenance",
    ];

    for (const type of orderedTypes) {
      const group = byType.get(type);
      if (!group || group.length === 0) continue;

      lines.push(``, `## ${TYPE_LABELS[type]} (${group.length})`, ``);
      for (const issue of group) {
        lines.push(`- **${issue.theme}**: ${issue.detail}`);
      }
    }

    // Stub candidates section
    if (stubs.length > 0) {
      lines.push(``, `## Stub candidates (${stubs.length})`, ``);
      for (const stub of stubs) {
        const countPart = stub.count !== undefined ? ` — mentioned ${stub.count} times` : "";
        lines.push(`- "${stub.term}"${countPart}: ${stub.detail}`);
      }
    }

    // Contradictions section
    if (contradictions.length > 0) {
      lines.push(``, `## Contradictions (${contradictions.length})`, ``);
      for (const c of contradictions) {
        const themePart =
          c.themes && c.themes.length >= 2 ? `**${c.themes[0]} vs ${c.themes[1]}**: ` : "";
        lines.push(`- ${themePart}${c.detail}`);
      }
      lines.push(``, `Contradictions require manual review.`);
    }
  }

  // --------------------------------------------------------------------
  // Orphan candidates — from classify.ts confidence-threshold routing.
  // Emit this section regardless of whether there are structural issues;
  // the candidates sidecar is independent of theme health.
  // --------------------------------------------------------------------
  try {
    const raw = await readFile(join(vault.warmDir, "_orphan-candidates.json"), "utf-8");
    const candidates = JSON.parse(raw) as Array<{
      entryTimestamp: string;
      source?: string;
      proposedThemes: string[];
      confidence: number;
      log: string;
    }>;
    if (candidates.length > 0) {
      hasOrphanCandidates = true;
      lines.push(``, `## Orphan candidates (${candidates.length})`, ``);
      lines.push(`Entries deferred because classifier confidence < 0.5:`, ``);
      for (const c of candidates) {
        const ts = c.entryTimestamp.slice(0, 10);
        lines.push(
          `- ${ts} ${c.source ?? "unknown"} — proposed: ${c.proposedThemes.join(", ")}, conf ${c.confidence}`
        );
      }
    }
  } catch {
    /* no orphan candidates file yet */
  }

  // --------------------------------------------------------------------
  // Concept candidates — count >= 3
  // --------------------------------------------------------------------
  try {
    const raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
    const map = JSON.parse(raw) as Record<
      string,
      { count: number; sources: string[]; firstSeen?: string }
    >;
    const frequent = Object.entries(map).filter(([, v]) => v.count >= 3);
    if (frequent.length > 0) {
      hasConceptCandidates = true;
      lines.push(``, `## Concept candidates (${frequent.length})`, ``);
      lines.push(`Terms mentioned across ≥3 entries with no page yet:`, ``);
      for (const [term, data] of frequent) {
        lines.push(
          `- "${term}" (${data.count} mentions) — sources: ${data.sources.slice(0, 3).join(", ")}`
        );
      }
    }
  } catch {
    /* no concept candidates file yet */
  }

  // --------------------------------------------------------------------
  // Actions footer — proposed fixes are written to the pending queue
  // automatically. Surface manual-only steps here.
  // --------------------------------------------------------------------
  const hasAnyFixable =
    totalIssues > 0 || hasOrphanCandidates || hasConceptCandidates;
  if (hasAnyFixable) {
    lines.push(``, `## Next steps`);
    lines.push(`Proposed fixes have been written to the pending queue — review them on the Review page.`);
    if (contradictions.length > 0) {
      lines.push(`- Contradictions require manual review (no auto-fix).`);
    }
    if (structural.some((i) => i.type === "broken-link")) {
      lines.push(`- Broken cross-references require manual review (no auto-fix yet).`);
    }
  }

  const lintPath = join(vault.warmDir, "_lint.md");
  await writeFile(lintPath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// createStubPendingUpdates
// ---------------------------------------------------------------------------
/**
 * Extract up to `n` paragraphs or sentences from `content` that mention `term`.
 * Used as context for the stub-synthesis LLM pass.
 */
function extractPassagesMentioning(term: string, content: string, n = 3): string[] {
  const termPattern = new RegExp(
    `(^|[^\\w])${term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}([^\\w]|$)`,
    "i"
  );
  // Split on double newline (paragraphs) first; fall back to sentences.
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim());
  const hits: string[] = [];
  for (const para of paragraphs) {
    if (termPattern.test(para)) {
      hits.push(para.trim().replace(/\s+/g, " ").slice(0, 400));
      if (hits.length >= n) break;
    }
  }
  return hits;
}

/**
 * Two-pass stub synthesis. Reads source themes, extracts passages that mention
 * the term, and asks the LLM to write a real Definition and Key Claims.
 * Returns null if synthesis fails; caller falls back to the stub template.
 */
async function synthesiseStubContent(opts: {
  term: string;
  sources: string[];
  vault: Vault;
  provider: LlmProvider;
  model: string;
}): Promise<{ definition: string; keyClaims: string[] } | null> {
  const { term, sources, vault, provider, model } = opts;

  // Gather concrete passages mentioning the term from each source theme.
  const passages: Array<{ theme: string; passage: string }> = [];
  for (const source of sources) {
    const doc = await readTheme(vault, source);
    if (!doc) continue;
    const hits = extractPassagesMentioning(term, doc.content, 2);
    for (const hit of hits) {
      passages.push({ theme: source, passage: hit });
    }
  }

  if (passages.length === 0) return null;

  const passageBlock = passages
    .map((p, i) => `[${i + 1}] From [[${p.theme}]]: "${p.passage}"`)
    .join("\n");

  const prompt = `Write a concept wiki page for "${term}" grounded ONLY in the passages below.

These are real excerpts from the wiki where "${term}" is mentioned.

${passageBlock}

Return a JSON object:
{
  "definition": "One paragraph (2-4 sentences) defining ${term} based on how it is actually used in the passages. No speculation, no boilerplate.",
  "key_claims": ["3-6 concrete claims about ${term} supported by the passages, each as a short bullet sentence"]
}

If the passages don't contain enough to write a meaningful definition (e.g. the term only appears as a code symbol without explanation), return {"definition": "", "key_claims": []}.`;

  try {
    const response = await provider.complete({ model, prompt, temperature: 0 });
    const parsed = JSON.parse(stripCodeFences(response)) as {
      definition: string;
      key_claims: string[];
    };
    if (!parsed.definition || !Array.isArray(parsed.key_claims)) return null;
    if (parsed.definition.trim() === "" && parsed.key_claims.length === 0) return null;
    return { definition: parsed.definition.trim(), keyClaims: parsed.key_claims };
  } catch (err) {
    await vaultLog("error", `synthesiseStubContent failed for ${term}`, String(err));
    return null;
  }
}

/**
 * Build a stub page. If synthesis succeeded, the page is filled with real
 * content. Otherwise returns a lightly-seeded TODO stub (with clear markers).
 */
function buildStubContent(opts: {
  term: string;
  detail?: string;
  count?: number;
  sources?: string[];
  synthesised?: { definition: string; keyClaims: string[] };
}): string {
  const { term, detail, count, sources, synthesised } = opts;
  const lines: string[] = [];

  lines.push(`## Definition`, ``);
  if (synthesised && synthesised.definition) {
    lines.push(synthesised.definition, ``);
  } else if (detail) {
    lines.push(
      detail,
      ``,
      `_(Review and rewrite — this description was auto-generated from context.)_`,
      ``
    );
  } else {
    lines.push(`TODO: Define "${term}".`, ``);
  }

  lines.push(`## Key Claims`, ``);
  if (synthesised && synthesised.keyClaims.length > 0) {
    for (const claim of synthesised.keyClaims) {
      lines.push(`- ${claim}`);
    }
    lines.push(``);
  } else {
    lines.push(`- _(to be filled in after reviewing the sources below)_`, ``);
  }

  lines.push(`## Related Concepts`, ``);
  if (sources && sources.length > 0) {
    for (const src of sources) lines.push(`- [[${src}]]`);
    lines.push(``);
  } else {
    lines.push(`_(none yet)_`, ``);
  }

  lines.push(`## Sources`, ``);
  if (count !== undefined && sources && sources.length > 0) {
    lines.push(
      `Lint surfaced this term across ${count} theme${count === 1 ? "" : "s"}: ${sources.map((s) => `[[${s}]]`).join(", ")}.`
    );
  } else {
    lines.push(`_(to be filled in)_`);
  }

  return lines.join("\n") + "\n";
}

async function createStubPendingUpdates(
  vault: Vault,
  stubs: SemanticIssue[],
  provider: LlmProvider,
  model: string
): Promise<void> {
  if (stubs.length === 0) return;
  const batchId = new Date().toISOString();
  let synthesisedCount = 0;
  let droppedCount = 0;

  for (const stub of stubs) {
    const term = stub.term ?? "unknown";
    const themeName = sanitizeThemeSlug(term);
    if (!themeName) continue;

    // Second-pass synthesis: read source themes and build real content.
    let synthesised: { definition: string; keyClaims: string[] } | null = null;
    if (stub.sources && stub.sources.length > 0) {
      synthesised = await synthesiseStubContent({
        term,
        sources: stub.sources,
        vault,
        provider,
        model,
      });
    }

    // If synthesis returned nothing substantive, skip the stub entirely.
    // An empty TODO page is worse than no page.
    if (!synthesised) {
      droppedCount++;
      continue;
    }
    synthesisedCount++;

    const proposedContent = buildStubContent({
      term,
      detail: stub.detail,
      count: stub.count,
      sources: stub.sources,
      synthesised,
    });
    const update = {
      id: randomUUID(),
      theme: themeName,
      proposedContent,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      type: "concept" as const,
      lintFix: "stubs" as const,
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
  }
  if (synthesisedCount > 0) {
    console.error(
      `[lint] Created ${synthesisedCount} stub pending update(s) with synthesised content` +
        (droppedCount > 0 ? ` (${droppedCount} dropped — no substantive passages)` : "")
    );
  } else if (droppedCount > 0) {
    console.error(`[lint] Dropped ${droppedCount} stub candidate(s) — no substantive source passages`);
  }
}

// ---------------------------------------------------------------------------
// createStubsFromConceptCandidates
// ---------------------------------------------------------------------------
async function createStubsFromConceptCandidates(
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<void> {
  try {
    const raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
    const map = JSON.parse(raw) as Record<string, { count: number; sources: string[] }>;
    const frequent = Object.entries(map).filter(([, v]) => v.count >= 3);
    const batchId = new Date().toISOString();
    let created = 0;
    let dropped = 0;
    for (const [term, data] of frequent) {
      const themeName = sanitizeThemeSlug(term);
      if (!themeName) continue;

      const synthesised = await synthesiseStubContent({
        term,
        sources: data.sources,
        vault,
        provider,
        model,
      });
      if (!synthesised) {
        dropped++;
        continue;
      }
      created++;

      const proposedContent = buildStubContent({
        term,
        count: data.count,
        sources: data.sources,
        synthesised,
      });
      const update = {
        id: randomUUID(),
        theme: themeName,
        proposedContent,
        previousContent: null,
        entries: [],
        createdAt: new Date().toISOString(),
        status: "pending" as const,
        batchId,
        type: "concept" as const,
        lintFix: "stubs" as const,
      };
      await writeFile(
        join(vault.pendingDir, `${update.id}.json`),
        JSON.stringify(update, null, 2),
        "utf-8"
      );
    }
    if (created > 0 || dropped > 0) {
      console.error(
        `[lint] Concept candidates: ${created} stub(s) created, ${dropped} dropped (no substantive passages)`
      );
    }
  } catch {
    /* ignore — no concept-candidates sidecar */
  }
}

// ---------------------------------------------------------------------------
// createOrphanPendingUpdates
// ---------------------------------------------------------------------------
async function createOrphanPendingUpdates(vault: Vault): Promise<void> {
  const path = join(vault.warmDir, "_orphan-candidates.json");
  try {
    const raw = await readFile(path, "utf-8");
    const candidates = JSON.parse(raw) as Array<{
      proposedThemes: string[];
      log: string;
      source?: string;
      entryTimestamp: string;
    }>;
    const batchId = new Date().toISOString();
    for (const c of candidates) {
      const theme = c.proposedThemes[0] ?? c.source ?? "uncategorized";
      const sourceId = `${c.entryTimestamp.slice(0, 10)}-${c.source ?? "unknown"}`;
      const update = {
        id: randomUUID(),
        theme,
        proposedContent: `## Current Status\n\n_(from orphaned entry, please review and edit)_\n\n${c.log.slice(0, 2000)}\n\n^[src:${sourceId}]\n`,
        previousContent: null,
        entries: [],
        createdAt: new Date().toISOString(),
        status: "pending" as const,
        batchId,
        lintFix: "orphans" as const,
      };
      await writeFile(
        join(vault.pendingDir, `${update.id}.json`),
        JSON.stringify(update, null, 2),
        "utf-8"
      );
    }
    if (candidates.length > 0) {
      console.error(
        `[lint] Created ${candidates.length} orphan pending update(s). Clearing candidates file.`
      );
      await writeFile(path, "[]", "utf-8");
    }
  } catch {
    /* no candidates */
  }
}

// ---------------------------------------------------------------------------
// createDeletePendingUpdates
// ---------------------------------------------------------------------------
async function createDeletePendingUpdates(
  vault: Vault,
  issues: StructuralIssue[]
): Promise<void> {
  if (issues.length === 0) return;
  const batchId = new Date().toISOString();
  for (const i of issues) {
    const update = {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: "",
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "delete" as const,
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
  }
  console.error(`[lint] Created ${issues.length} delete pending update(s).`);
}

// ---------------------------------------------------------------------------
// createMergePendingUpdates
// ---------------------------------------------------------------------------
async function createMergePendingUpdates(
  vault: Vault,
  issues: StructuralIssue[]
): Promise<void> {
  if (issues.length === 0) return;
  const batchId = new Date().toISOString();
  let created = 0;
  for (const i of issues) {
    if (!i.target) continue;
    const update = {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: `## Merge proposal\n\nMerge [[${i.theme}]] → [[${i.target}]]\nReason: ${i.detail}`,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "merge" as const,
      related: [i.target],
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
    created += 1;
  }
  if (created > 0) console.error(`[lint] Created ${created} merge pending update(s).`);
}

// ---------------------------------------------------------------------------
// createRenamePendingUpdate
// ---------------------------------------------------------------------------
async function createRenamePendingUpdate(
  vault: Vault,
  from: string,
  to: string
): Promise<void> {
  const update = {
    id: randomUUID(),
    theme: from,
    proposedContent: `## Rename proposal\n\nRename [[${from}]] → [[${to}]]\n`,
    previousContent: null,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending" as const,
    batchId: new Date().toISOString(),
    lintFix: "rename" as const,
    related: [to],
  };
  await writeFile(
    join(vault.pendingDir, `${update.id}.json`),
    JSON.stringify(update, null, 2),
    "utf-8"
  );
  console.error(`[lint] Created rename pending update: ${from} → ${to}`);
}

// ---------------------------------------------------------------------------
// createBrokenLinkPendingUpdates
//
// For each source theme containing broken [[targets]], if a target normalises
// to an existing theme name, propose a rewrite that fixes all such links in
// that source theme in one go. Broken targets with no match are left flagged.
// ---------------------------------------------------------------------------
async function createBrokenLinkPendingUpdates(
  vault: Vault,
  issues: StructuralIssue[]
): Promise<void> {
  if (issues.length === 0) return;

  const existingThemes = new Set(await listThemes(vault));
  // Group broken-link issues by source theme
  const bySource = new Map<string, Array<{ target: string; replacement: string }>>();

  for (const issue of issues) {
    if (!issue.target) continue;
    const candidate = sanitizeThemeSlug(issue.target);
    if (!candidate || !existingThemes.has(candidate)) continue;
    if (candidate === issue.target) continue; // already correct somehow

    const list = bySource.get(issue.theme) ?? [];
    list.push({ target: issue.target, replacement: candidate });
    bySource.set(issue.theme, list);
  }

  if (bySource.size === 0) return;

  const batchId = new Date().toISOString();
  let created = 0;

  for (const [sourceTheme, fixes] of bySource) {
    const doc = await readTheme(vault, sourceTheme);
    if (!doc) continue;

    let content = doc.content;
    const applied: string[] = [];
    for (const { target, replacement } of fixes) {
      // Escape regex special chars in target
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\[\\[${escaped}\\]\\]`, "g");
      if (re.test(content)) {
        content = content.replace(re, `[[${replacement}]]`);
        applied.push(`${target} → ${replacement}`);
      }
    }
    if (applied.length === 0) continue;

    const update = {
      id: randomUUID(),
      theme: sourceTheme,
      proposedContent: content,
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "broken-link" as const,
      fixDetail: applied.join(", "),
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
    created++;
  }

  if (created > 0) {
    console.error(`[lint] Created ${created} broken-link rewrite pending update(s).`);
  }
}

// ---------------------------------------------------------------------------
// createDedupDatePendingUpdates
//
// For each theme with duplicate `### YYYY-MM-DD` headings in the Activity Log,
// merge the bullets under the duplicates into the first occurrence and drop
// the later duplicates. Purely deterministic — preserves all bullet content.
// ---------------------------------------------------------------------------
async function createDedupDatePendingUpdates(
  vault: Vault,
  issues: StructuralIssue[]
): Promise<void> {
  const relevant = issues.filter((i) => i.type === "duplicate-date");
  if (relevant.length === 0) return;

  // One issue per duplicate found; deduplicate by theme
  const themes = Array.from(new Set(relevant.map((i) => i.theme)));
  const batchId = new Date().toISOString();
  let created = 0;

  for (const theme of themes) {
    const doc = await readTheme(vault, theme);
    if (!doc) continue;

    const deduped = mergeDuplicateDates(doc.content);
    if (deduped === doc.content) continue; // no-op guard

    const update = {
      id: randomUUID(),
      theme,
      proposedContent: deduped,
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "dedup-dates" as const,
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
    created++;
  }

  if (created > 0) {
    console.error(`[lint] Created ${created} dedup-dates pending update(s).`);
  }
}

/**
 * Merge duplicate `### YYYY-MM-DD` sections. First occurrence keeps its
 * heading and content; subsequent occurrences' bullets are appended to the
 * first occurrence and their headings are removed.
 *
 * Exported for testing.
 */
export function mergeDuplicateDates(content: string): string {
  const lines = content.split("\n");
  const datePattern = /^###\s+(\d{4}-\d{2}-\d{2})(.*)$/;

  // First pass: locate all date-heading lines
  type Section = { date: string; headingLine: number; endLine: number };
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(datePattern);
    if (m) {
      if (sections.length > 0) sections[sections.length - 1].endLine = i - 1;
      sections.push({ date: m[1], headingLine: i, endLine: lines.length - 1 });
    } else if (lines[i].match(/^##?\s/) && sections.length > 0 && sections[sections.length - 1].endLine === lines.length - 1) {
      // Top-level heading stops the current section
      sections[sections.length - 1].endLine = i - 1;
    }
  }
  if (sections.length === 0) return content;

  // Group sections by date
  const byDate = new Map<string, Section[]>();
  for (const s of sections) {
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }

  // Find dates that have duplicates
  const duplicates = Array.from(byDate.entries()).filter(([, list]) => list.length > 1);
  if (duplicates.length === 0) return content;

  // Build new content: keep first occurrence, append body-lines from duplicates, drop duplicate heading+body
  const dropLines = new Set<number>();
  const appendTo = new Map<number, string[]>(); // target heading line → lines to append

  for (const [, list] of duplicates) {
    const [first, ...rest] = list;
    const extras: string[] = [];
    for (const dup of rest) {
      // Body = lines after heading, through endLine
      for (let l = dup.headingLine; l <= dup.endLine; l++) {
        dropLines.add(l);
        if (l > dup.headingLine) extras.push(lines[l]);
      }
    }
    if (extras.length > 0) appendTo.set(first.endLine, extras);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (dropLines.has(i)) continue;
    out.push(lines[i]);
    const appendix = appendTo.get(i);
    if (appendix) out.push(...appendix);
  }

  // Normalise trailing blank lines
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// createOrphanDeletePendingUpdates
//
// Structural orphans with essentially no content (stub Current Status, ≤ 1
// Activity Log entry, or entirely "No activity recorded") are proposed for
// deletion. Orphans with substantive content are left flagged for manual
// linking — we don't auto-delete real pages.
// ---------------------------------------------------------------------------
async function createOrphanDeletePendingUpdates(
  vault: Vault,
  issues: StructuralIssue[]
): Promise<void> {
  const orphans = issues.filter((i) => i.type === "orphan");
  if (orphans.length === 0) return;

  const batchId = new Date().toISOString();
  let created = 0;

  for (const orphan of orphans) {
    const doc = await readTheme(vault, orphan.theme);
    if (!doc) continue;
    if (!isEssentiallyEmpty(doc.content)) continue;

    const update = {
      id: randomUUID(),
      theme: orphan.theme,
      proposedContent: "",
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "delete" as const,
      fixReason: "orphan with no substantive content",
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );
    created++;
  }

  if (created > 0) {
    console.error(`[lint] Created ${created} orphan-delete pending update(s).`);
  }
}

/**
 * A theme is "essentially empty" if its Activity Log has zero or one dated
 * sections, OR every substantive paragraph says "no activity" / "no data".
 *
 * Exported for testing.
 */
export function isEssentiallyEmpty(content: string): boolean {
  const sectionCount = (content.match(/^###\s+\d{4}-\d{2}-\d{2}/gm) ?? []).length;
  if (sectionCount > 1) return false;

  // Remove headings and blank lines to check remaining substance
  const meaningful = content
    .split("\n")
    .filter((l) => l.trim() && !l.match(/^#{1,4}\s/))
    .join(" ")
    .toLowerCase();

  if (meaningful.length < 40) return true;

  // Mostly-no-activity phrasing
  const noActivityTokens = [
    "no activity",
    "no data",
    "no recent activity",
    "nothing to report",
    "no new",
    "no changes",
  ];
  const hits = noActivityTokens.reduce(
    (n, token) => n + (meaningful.includes(token) ? 1 : 0),
    0
  );
  // If the page is short AND at least one "no activity" phrase dominates, treat as empty
  if (meaningful.length < 200 && hits >= 1) return true;
  return false;
}

// ---------------------------------------------------------------------------
// runLint — testable entry point. main() just parses argv and calls this.
// ---------------------------------------------------------------------------
export interface LintOptions {
  vault: Vault;
  provider: import("@openpulse/core").LlmProvider;
  model: string;
  fix?:
    | "stubs"
    | "orphans"
    | "merge"
    | "delete-lowvalue"
    | "rename"
    | "broken-links"
    | "dedup-dates"
    | "empty-orphans";
  noFix?: boolean;
  from?: string;
  to?: string;
}

export interface LintResult {
  structuralIssues: number;
  stubs: number;
  contradictions: number;
  themeCount: number;
}

export async function runLint(opts: LintOptions): Promise<LintResult> {
  const { vault, provider, model, fix, noFix, from, to } = opts;

  const structural = await runStructuralChecks(vault);
  const stubs = await findStubCandidates(vault, provider, model);
  const contradictions = await findContradictions(vault, provider, model);

  const themeCount = (await listThemes(vault)).length;
  await writeLintReport(vault, structural, stubs, contradictions, themeCount);

  const totalIssues = structural.length + stubs.length + contradictions.length;
  console.error(
    `[lint] ${totalIssues} issue(s) found across ${themeCount} themes — see vault/warm/_lint.md`
  );

  const result: LintResult = {
    structuralIssues: structural.length,
    stubs: stubs.length,
    contradictions: contradictions.length,
    themeCount,
  };

  // Rename is always explicit — requires from/to.
  if (fix === "rename") {
    if (!from || !to) throw new Error("--fix=rename requires --from and --to");
    await createRenamePendingUpdate(vault, from, to);
    return result;
  }

  if (noFix) return result;

  // Default run (no fix flag) runs ALL fix modes. A specific fix=X runs only that one.
  // Each mode writes its own batch so the Review page groups them by type.
  const runAll = fix === undefined;

  if (runAll || fix === "stubs") {
    await createStubPendingUpdates(vault, stubs, provider, model);
    await createStubsFromConceptCandidates(vault, provider, model);
  }
  if (runAll || fix === "orphans") {
    await createOrphanPendingUpdates(vault);
  }
  if (runAll || fix === "delete-lowvalue") {
    await createDeletePendingUpdates(
      vault,
      structural.filter((i) => i.type === "low-value")
    );
  }
  if (runAll || fix === "merge") {
    await createMergePendingUpdates(
      vault,
      structural.filter((i) => i.type === "duplicate-theme")
    );
  }
  if (runAll || fix === "broken-links") {
    await createBrokenLinkPendingUpdates(
      vault,
      structural.filter((i) => i.type === "broken-link")
    );
  }
  if (runAll || fix === "dedup-dates") {
    await createDedupDatePendingUpdates(
      vault,
      structural.filter((i) => i.type === "duplicate-date")
    );
  }
  if (runAll || fix === "empty-orphans") {
    await createOrphanDeletePendingUpdates(
      vault,
      structural.filter((i) => i.type === "orphan")
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// main — CLI entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const config = await loadConfig(VAULT_ROOT);
  initLogger(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  await vaultLog("info", "Wiki lint started");

  const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
  const to = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1];
  const noFix = process.argv.includes("--no-fix");

  const result = await runLint({ vault, provider, model, fix: fixFlag, noFix, from, to });
  await vaultLog(
    "info",
    `Wiki lint complete: ${result.structuralIssues} structural issues`,
    `${result.themeCount} themes checked`
  );
}

// Only run main() when invoked directly, not when imported by tests.
const invoked = import.meta.url === `file://${process.argv[1]}`;
if (invoked) {
  main().catch((err) => {
    console.error("[lint] Fatal:", err);
    process.exit(1);
  });
}
