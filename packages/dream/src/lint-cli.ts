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
import { ABSENCE_LINE } from "./classify.js";

/** Escape regex metacharacters so a runtime string can be embedded in a pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Shape of a lint-proposed pending update. Narrower than PendingUpdate — only
 *  the fields this module writes. Kept loose to tolerate optional extras. */
type LintPending = {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: unknown[];
  createdAt: string;
  status: "pending";
  batchId: string;
  lintFix: string;
  type?: "concept";
  related?: string[];
  fixReason?: string;
  fixDetail?: string;
};

async function writePendingUpdate(vault: Vault, update: LintPending): Promise<void> {
  await writeFile(
    join(vault.pendingDir, `${update.id}.json`),
    JSON.stringify(update, null, 2),
    "utf-8"
  );
}

/** In-memory cache of warm themes to avoid re-reading the same file across
 *  multiple fix passes within a single runLint invocation. */
class ThemeCache {
  private cache = new Map<string, Awaited<ReturnType<typeof readTheme>> | null>();
  constructor(private vault: Vault) {}
  async get(name: string) {
    if (this.cache.has(name)) return this.cache.get(name) ?? null;
    const doc = await readTheme(this.vault, name);
    this.cache.set(name, doc);
    return doc;
  }
  async getMany(names: string[]) {
    const unseen = names.filter((n) => !this.cache.has(n));
    if (unseen.length > 0) {
      const docs = await Promise.all(unseen.map((n) => readTheme(this.vault, n)));
      unseen.forEach((n, i) => this.cache.set(n, docs[i]));
    }
    return names.map((n) => this.cache.get(n) ?? null);
  }
}

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
/** Extract up to `n` paragraphs from `content` that mention `term`. */
function extractPassagesMentioning(term: string, content: string, n = 3): string[] {
  const termPattern = new RegExp(`(^|[^\\w])${escapeRegex(term)}([^\\w]|$)`, "i");
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
  themes: ThemeCache;
  provider: LlmProvider;
  model: string;
}): Promise<{ definition: string; keyClaims: string[] } | null> {
  const { term, sources, themes, provider, model } = opts;

  const docs = await themes.getMany(sources);
  const passages: Array<{ theme: string; passage: string }> = [];
  for (let i = 0; i < sources.length; i++) {
    const doc = docs[i];
    if (!doc) continue;
    for (const hit of extractPassagesMentioning(term, doc.content, 2)) {
      passages.push({ theme: sources[i], passage: hit });
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
  themes: ThemeCache,
  provider: LlmProvider,
  model: string
): Promise<void> {
  if (stubs.length === 0) return;
  const batchId = new Date().toISOString();
  let created = 0;
  let dropped = 0;

  for (const stub of stubs) {
    const term = stub.term ?? "unknown";
    const themeName = sanitizeThemeSlug(term);
    if (!themeName) continue;

    const synthesised = stub.sources?.length
      ? await synthesiseStubContent({ term, sources: stub.sources, themes, provider, model })
      : null;

    if (!synthesised) {
      dropped++;
      continue;
    }
    created++;

    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: themeName,
      proposedContent: buildStubContent({
        term,
        detail: stub.detail,
        count: stub.count,
        sources: stub.sources,
        synthesised,
      }),
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      type: "concept",
      lintFix: "stubs",
    });
  }
  if (created > 0) {
    console.error(
      `[lint] Created ${created} stub pending update(s)` +
        (dropped > 0 ? ` (${dropped} dropped — no substantive passages)` : "")
    );
  } else if (dropped > 0) {
    console.error(`[lint] Dropped ${dropped} stub candidate(s) — no substantive source passages`);
  }
}

// ---------------------------------------------------------------------------
// createStubsFromConceptCandidates
// ---------------------------------------------------------------------------
async function createStubsFromConceptCandidates(
  vault: Vault,
  themes: ThemeCache,
  provider: LlmProvider,
  model: string
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
  } catch {
    return;
  }
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
      themes,
      provider,
      model,
    });
    if (!synthesised) {
      dropped++;
      continue;
    }
    created++;

    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: themeName,
      proposedContent: buildStubContent({
        term,
        count: data.count,
        sources: data.sources,
        synthesised,
      }),
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      type: "concept",
      lintFix: "stubs",
    });
  }
  if (created > 0 || dropped > 0) {
    console.error(
      `[lint] Concept candidates: ${created} stub(s) created, ${dropped} dropped`
    );
  }
}

// ---------------------------------------------------------------------------
// createOrphanPendingUpdates
// ---------------------------------------------------------------------------
async function createOrphanPendingUpdates(vault: Vault): Promise<void> {
  const path = join(vault.warmDir, "_orphan-candidates.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return;
  }
  const candidates = JSON.parse(raw) as Array<{
    proposedThemes: string[];
    log: string;
    source?: string;
    entryTimestamp: string;
  }>;
  if (candidates.length === 0) return;
  const batchId = new Date().toISOString();
  for (const c of candidates) {
    const theme = c.proposedThemes[0] ?? c.source ?? "uncategorized";
    const sourceId = `${c.entryTimestamp.slice(0, 10)}-${c.source ?? "unknown"}`;
    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme,
      proposedContent: `## Current Status\n\n_(from orphaned entry, please review and edit)_\n\n${c.log.slice(0, 2000)}\n\n^[src:${sourceId}]\n`,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "orphans",
    });
  }
  console.error(
    `[lint] Created ${candidates.length} orphan pending update(s). Clearing candidates file.`
  );
  await writeFile(path, "[]", "utf-8");
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
    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: "",
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "delete",
    });
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
    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: `## Merge proposal\n\nMerge [[${i.theme}]] → [[${i.target}]]\nReason: ${i.detail}`,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "merge",
      related: [i.target],
    });
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
  await writePendingUpdate(vault, {
    id: randomUUID(),
    theme: from,
    proposedContent: `## Rename proposal\n\nRename [[${from}]] → [[${to}]]\n`,
    previousContent: null,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    lintFix: "rename",
    related: [to],
  });
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
  issues: StructuralIssue[],
  themes: ThemeCache,
  existingThemes: Set<string>
): Promise<void> {
  if (issues.length === 0) return;

  const bySource = new Map<string, Array<{ target: string; replacement: string }>>();
  for (const issue of issues) {
    if (!issue.target) continue;
    const candidate = sanitizeThemeSlug(issue.target);
    if (!candidate || !existingThemes.has(candidate)) continue;
    if (candidate === issue.target) continue;
    const list = bySource.get(issue.theme) ?? [];
    list.push({ target: issue.target, replacement: candidate });
    bySource.set(issue.theme, list);
  }
  if (bySource.size === 0) return;

  const batchId = new Date().toISOString();
  let created = 0;

  for (const [sourceTheme, fixes] of bySource) {
    const doc = await themes.get(sourceTheme);
    if (!doc) continue;

    let content = doc.content;
    const applied: string[] = [];
    for (const { target, replacement } of fixes) {
      const re = new RegExp(`\\[\\[${escapeRegex(target)}\\]\\]`, "g");
      if (re.test(content)) {
        content = content.replace(re, `[[${replacement}]]`);
        applied.push(`${target} → ${replacement}`);
      }
    }
    if (applied.length === 0) continue;

    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: sourceTheme,
      proposedContent: content,
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "broken-link",
      fixDetail: applied.join(", "),
    });
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
  issues: StructuralIssue[],
  themes: ThemeCache
): Promise<void> {
  const relevant = issues.filter((i) => i.type === "duplicate-date");
  if (relevant.length === 0) return;

  const uniqueThemes = Array.from(new Set(relevant.map((i) => i.theme)));
  const batchId = new Date().toISOString();
  let created = 0;

  for (const theme of uniqueThemes) {
    const doc = await themes.get(theme);
    if (!doc) continue;

    const deduped = mergeDuplicateDates(doc.content);
    if (deduped === doc.content) continue;

    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme,
      proposedContent: deduped,
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "dedup-dates",
    });
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

  type Section = { date: string; headingLine: number; endLine: number };
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(datePattern);
    if (m) {
      if (sections.length > 0) sections[sections.length - 1].endLine = i - 1;
      sections.push({ date: m[1], headingLine: i, endLine: lines.length - 1 });
    } else if (lines[i].match(/^##?\s/) && sections.length > 0 && sections[sections.length - 1].endLine === lines.length - 1) {
      // A top-level heading ends the current date-section, even though the
      // section-tracking loop only looks for ### headings to open a new one.
      sections[sections.length - 1].endLine = i - 1;
    }
  }
  if (sections.length === 0) return content;

  const byDate = new Map<string, Section[]>();
  for (const s of sections) {
    const list = byDate.get(s.date) ?? [];
    list.push(s);
    byDate.set(s.date, list);
  }

  const duplicates = Array.from(byDate.entries()).filter(([, list]) => list.length > 1);
  if (duplicates.length === 0) return content;

  const dropLines = new Set<number>();
  const appendTo = new Map<number, string[]>();

  for (const [, list] of duplicates) {
    const [first, ...rest] = list;
    const extras: string[] = [];
    for (const dup of rest) {
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
  issues: StructuralIssue[],
  themes: ThemeCache
): Promise<void> {
  const orphans = issues.filter((i) => i.type === "orphan");
  if (orphans.length === 0) return;

  const batchId = new Date().toISOString();
  let created = 0;

  for (const orphan of orphans) {
    const doc = await themes.get(orphan.theme);
    if (!doc || !isEssentiallyEmpty(doc.content)) continue;

    await writePendingUpdate(vault, {
      id: randomUUID(),
      theme: orphan.theme,
      proposedContent: "",
      previousContent: doc.content,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending",
      batchId,
      lintFix: "delete",
      fixReason: "orphan with no substantive content",
    });
    created++;
  }

  if (created > 0) {
    console.error(`[lint] Created ${created} orphan-delete pending update(s).`);
  }
}

/**
 * True if the theme has no substantive content: ≤ 1 dated section AND its
 * prose is either very short or dominated by `ABSENCE_LINE` "no activity"
 * phrasing (shared with classify.ts — the same filter that drops noise
 * entries before they reach synthesis).
 *
 * Exported for testing.
 */
export function isEssentiallyEmpty(content: string): boolean {
  const sectionCount = (content.match(/^###\s+\d{4}-\d{2}-\d{2}/gm) ?? []).length;
  if (sectionCount > 1) return false;

  const meaningful = content
    .split("\n")
    .filter((l) => l.trim() && !l.match(/^#{1,4}\s/))
    .join(" ");

  if (meaningful.length < 40) return true;
  if (meaningful.length < 200 && ABSENCE_LINE.test(meaningful)) return true;
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

  const themeNames = await listThemes(vault);
  const themeCount = themeNames.length;
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

  if (fix === "rename") {
    if (!from || !to) throw new Error("--fix=rename requires --from and --to");
    await createRenamePendingUpdate(vault, from, to);
    return result;
  }

  if (noFix) return result;

  // Each mode writes its own batch so the Review page groups them by type.
  const runAll = fix === undefined;
  const themes = new ThemeCache(vault);
  const existingThemes = new Set(themeNames);

  if (runAll || fix === "stubs") {
    await createStubPendingUpdates(vault, stubs, themes, provider, model);
    await createStubsFromConceptCandidates(vault, themes, provider, model);
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
      structural.filter((i) => i.type === "broken-link"),
      themes,
      existingThemes
    );
  }
  if (runAll || fix === "dedup-dates") {
    await createDedupDatePendingUpdates(
      vault,
      structural.filter((i) => i.type === "duplicate-date"),
      themes
    );
  }
  if (runAll || fix === "empty-orphans") {
    await createOrphanDeletePendingUpdates(
      vault,
      structural.filter((i) => i.type === "orphan"),
      themes
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
