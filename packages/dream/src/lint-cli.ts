#!/usr/bin/env node
/**
 * openpulse-lint — Wiki lint CLI entry point
 *
 * Usage:
 *   openpulse-lint
 *   openpulse-lint --fix=stubs
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Vault,
  loadConfig,
  createProvider,
  initLogger,
  vaultLog,
  listThemes,
} from "@openpulse/core";
import { runStructuralChecks, type StructuralIssue } from "./lint-structural.js";
import { findStubCandidates, findContradictions, type SemanticIssue } from "./lint-semantic.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const fixFlag = process.argv.find((a) => a.startsWith("--fix="))?.split("=")[1] as
  | "stubs"
  | "orphans"
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

  let md = `# Wiki Lint — ${today}\n`;

  if (totalIssues === 0) {
    md += `\n✓ All ${themeCount} themes look healthy.\n`;
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
    ];

    for (const type of orderedTypes) {
      const group = byType.get(type);
      if (!group || group.length === 0) continue;

      md += `\n## ${TYPE_LABELS[type]} (${group.length})\n\n`;
      for (const issue of group) {
        md += `- **${issue.theme}**: ${issue.detail}\n`;
      }
    }

    // Stub candidates section
    if (stubs.length > 0) {
      md += `\n## Stub candidates (${stubs.length})\n\n`;
      for (const stub of stubs) {
        const countPart = stub.count !== undefined ? ` — mentioned ${stub.count} times` : "";
        md += `- "${stub.term}"${countPart}: ${stub.detail}\n`;
      }
      md += `\nRun \`openpulse-lint --fix=stubs\` to create stub pages as pending updates.\n`;
    }

    // Contradictions section
    if (contradictions.length > 0) {
      md += `\n## Contradictions (${contradictions.length})\n\n`;
      for (const c of contradictions) {
        const themePart =
          c.themes && c.themes.length >= 2 ? `**${c.themes[0]} vs ${c.themes[1]}**: ` : "";
        md += `- ${themePart}${c.detail}\n`;
      }
      md += `\nContradictions require manual review.\n`;
    }

    // Actions section
    md += `\n## Actions\n`;
    md += `- Run \`openpulse-lint --fix=stubs\` to create stub pages as pending updates\n`;
    md += `- Contradictions require manual review\n`;
  }

  const lintPath = join(vault.warmDir, "_lint.md");
  await writeFile(lintPath, md, "utf-8");
}

// ---------------------------------------------------------------------------
// createStubPendingUpdates
// ---------------------------------------------------------------------------
async function createStubPendingUpdates(vault: Vault, stubs: SemanticIssue[]): Promise<void> {
  if (stubs.length === 0) return;
  const { randomUUID } = await import("node:crypto");
  const batchId = new Date().toISOString();
  for (const stub of stubs) {
    const themeName = (stub.term ?? "unknown").toLowerCase().replace(/\s+/g, "-");
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

  if (fixFlag === "stubs") await createStubPendingUpdates(vault, stubs);
}

main().catch((err) => {
  console.error("[lint] Fatal:", err);
  process.exit(1);
});
