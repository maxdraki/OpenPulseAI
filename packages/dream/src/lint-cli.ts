#!/usr/bin/env node
/**
 * openpulse-lint — Wiki lint CLI entry point
 *
 * Usage:
 *   openpulse-lint
 *   openpulse-lint --fix=stubs
 *   openpulse-lint --fix=orphans
 *   openpulse-lint --fix=merge
 *   openpulse-lint --fix=delete-lowvalue
 *   openpulse-lint --fix=rename --from=X --to=Y
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
  sanitizeThemeSlug,
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
      lines.push(``, `Run \`openpulse-lint --fix=stubs\` to create stub pages as pending updates.`);
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
      lines.push(``, `Run \`openpulse-lint --fix=orphans\` to review and approve.`);
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
      lines.push(
        ``,
        `Run \`openpulse-lint --fix=stubs\` to create concept pages as pending updates.`
      );
    }
  } catch {
    /* no concept candidates file yet */
  }

  // --------------------------------------------------------------------
  // Actions footer — only when there is something actionable
  // --------------------------------------------------------------------
  const hasAnyFixable =
    totalIssues > 0 || hasOrphanCandidates || hasConceptCandidates;
  if (hasAnyFixable && totalIssues > 0) {
    lines.push(``, `## Actions`);
    if (stubs.length > 0 || hasConceptCandidates) {
      lines.push(
        `- Run \`openpulse-lint --fix=stubs\` to create stub pages as pending updates`
      );
    }
    if (hasOrphanCandidates) {
      lines.push(
        `- Run \`openpulse-lint --fix=orphans\` to propose cross-references`
      );
    }
    if (structural.some((i) => i.type === "low-value")) {
      lines.push(
        `- Run \`openpulse-lint --fix=delete-lowvalue\` to propose deletion of low-value pages`
      );
    }
    if (structural.some((i) => i.type === "duplicate-theme")) {
      lines.push(
        `- Run \`openpulse-lint --fix=merge\` to propose merging duplicate themes`
      );
    }
    if (contradictions.length > 0) {
      lines.push(`- Contradictions require manual review`);
    }
  } else if (hasAnyFixable) {
    // Healthy themes but sidecar candidates exist — still show actions.
    lines.push(``, `## Actions`);
    if (hasConceptCandidates) {
      lines.push(
        `- Run \`openpulse-lint --fix=stubs\` to create concept stub pages as pending updates`
      );
    }
    if (hasOrphanCandidates) {
      lines.push(
        `- Run \`openpulse-lint --fix=orphans\` to propose cross-references`
      );
    }
  }

  const lintPath = join(vault.warmDir, "_lint.md");
  await writeFile(lintPath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// createStubPendingUpdates
// ---------------------------------------------------------------------------
async function createStubPendingUpdates(vault: Vault, stubs: SemanticIssue[]): Promise<void> {
  if (stubs.length === 0) return;
  const batchId = new Date().toISOString();
  for (const stub of stubs) {
    const themeName = sanitizeThemeSlug(stub.term ?? "unknown");
    const proposedContent = `## Definition\n\nTODO: Define "${stub.term}".\n\n## Key Claims\n\n- _(to be filled in)_\n\n## Related Concepts\n\n## Sources\n`;
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
  console.error(`[lint] Created ${stubs.length} stub pending update(s) — review in Control Center`);
}

// ---------------------------------------------------------------------------
// createStubsFromConceptCandidates
// ---------------------------------------------------------------------------
async function createStubsFromConceptCandidates(vault: Vault): Promise<void> {
  try {
    const raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
    const map = JSON.parse(raw) as Record<string, { count: number; sources: string[] }>;
    const frequent = Object.entries(map).filter(([, v]) => v.count >= 3);
    const batchId = new Date().toISOString();
    for (const [term] of frequent) {
      const themeName = sanitizeThemeSlug(term);
      if (!themeName) continue;  // skip if sanitization zeroed it out
      const update = {
        id: randomUUID(),
        theme: themeName,
        proposedContent: `## Definition\n\nTODO: Define "${term}".\n\n## Key Claims\n\n- _(to be filled in)_\n\n## Related Concepts\n\n## Sources\n`,
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
    if (frequent.length > 0) {
      console.error(
        `[lint] Created ${frequent.length} concept stub pending update(s) from candidates`
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
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const config = await loadConfig(VAULT_ROOT);
  initLogger(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  await vaultLog("info", "Wiki lint started");

  const structural = await runStructuralChecks(vault);
  const stubs = await findStubCandidates(vault, provider, model);
  const contradictions = await findContradictions(vault, provider, model);

  const themeCount = (await listThemes(vault)).length;
  await writeLintReport(vault, structural, stubs, contradictions, themeCount);

  const totalIssues = structural.length + stubs.length + contradictions.length;
  console.error(
    `[lint] ${totalIssues} issue(s) found across ${themeCount} themes — see vault/warm/_lint.md`
  );
  await vaultLog("info", `Wiki lint complete: ${totalIssues} issues`, `${themeCount} themes checked`);

  // Dispatch --fix modes
  if (fixFlag === "stubs") {
    await createStubPendingUpdates(vault, stubs);
    await createStubsFromConceptCandidates(vault);
  } else if (fixFlag === "orphans") {
    await createOrphanPendingUpdates(vault);
  } else if (fixFlag === "delete-lowvalue") {
    await createDeletePendingUpdates(
      vault,
      structural.filter((i) => i.type === "low-value")
    );
  } else if (fixFlag === "merge") {
    await createMergePendingUpdates(
      vault,
      structural.filter((i) => i.type === "duplicate-theme")
    );
  } else if (fixFlag === "rename") {
    const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
    const to = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1];
    if (!from || !to) {
      console.error("--fix=rename requires --from= and --to=");
      process.exit(1);
    }
    await createRenamePendingUpdate(vault, from, to);
  }
}

main().catch((err) => {
  console.error("[lint] Fatal:", err);
  process.exit(1);
});
