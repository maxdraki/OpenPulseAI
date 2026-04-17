#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Vault, loadConfig, createProvider, initLogger, vaultLog, listThemes, readTheme,
} from "@openpulse/core";
import type { LlmProvider, PendingUpdate, ThemeType } from "@openpulse/core";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

/**
 * Core: read schema + sample themes + LLM-propose edits + write pending update if non-null.
 * Returns true if a pending update was written.
 */
export async function proposeSchemaChanges(
  vault: Vault, provider: LlmProvider, model: string, dryRun: boolean
): Promise<boolean> {
  const schemaPath = join(vault.warmDir, "_schema.md");
  let currentSchema = "";
  try { currentSchema = await readFile(schemaPath, "utf-8"); } catch {
    await vaultLog("warn", "[schema-evolve] No _schema.md found; run dream pipeline first to seed it.");
    return false;
  }

  const themeNames = await listThemes(vault);
  const docs = await Promise.all(themeNames.map((n) => readTheme(vault, n)));
  const byType: Record<string, Array<{ theme: string; content: string; lastUpdated: string }>> = {
    project: [], concept: [], entity: [], "source-summary": [],
  };
  for (const d of docs) {
    if (!d) continue;
    const t = d.type ?? "project";
    byType[t]?.push({ theme: d.theme, content: d.content, lastUpdated: d.lastUpdated });
  }
  for (const list of Object.values(byType)) list.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));

  const sampleBlock = Object.entries(byType).map(([type, items]) => {
    const top = items.slice(0, 3);
    if (top.length === 0) return `${type}: (no pages)`;
    return `${type}:\n${top.map((t) => `[[${t.theme}]]:\n${t.content.slice(0, 600)}\n---`).join("\n")}`;
  }).join("\n\n===\n\n");

  const prompt = `You are reviewing a wiki schema against observed page content.

Current schema:
${currentSchema}

Sample pages by type:
${sampleBlock}

Based on observed patterns, propose edits to the schema. You may:
- Tweak structure or rules for an existing type
- Propose a new type (with structure, rules, when-to-use)
- Propose removing or merging an existing type

Only propose changes if there is concrete evidence in the samples.

Return ONLY JSON:
{
  "proposed_schema_content": <full new _schema.md text | null>,
  "rationale": [{"change": "...", "evidence": "..."}],
  "confidence": "high" | "medium" | "low"
}
If no changes warranted, proposed_schema_content must be null.`;

  const response = await provider.complete({ model, prompt, temperature: 0, maxTokens: 3072 });
  let parsed: {
    proposed_schema_content: string | null;
    rationale: Array<{ change: string; evidence: string }>;
    confidence: "high" | "medium" | "low";
  };
  try {
    let j = response.trim();
    if (j.startsWith("```")) j = j.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(j);
  } catch {
    await vaultLog("warn", "[schema-evolve] LLM parse failed");
    return false;
  }

  if (dryRun) {
    console.error("Rationale:", JSON.stringify(parsed.rationale, null, 2));
    console.error("Confidence:", parsed.confidence);
    console.error("Proposal:", parsed.proposed_schema_content ?? "(none)");
    return false;
  }

  if (!parsed.proposed_schema_content) {
    await vaultLog("info", "[schema-evolve] No changes warranted this run.");
    return false;
  }

  const update: PendingUpdate = {
    id: randomUUID(),
    theme: "_schema",
    proposedContent: parsed.proposed_schema_content,
    previousContent: currentSchema,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type: "project" as ThemeType,  // placeholder; routing by schemaEvolution field
    schemaEvolution: {
      rationale: parsed.rationale,
      confidence: parsed.confidence,
    },
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  await vaultLog("info", "[schema-evolve] Wrote schema-evolution pending update.");
  return true;
}

async function alreadyRanThisMonth(vaultRoot: string): Promise<boolean> {
  const path = join(vaultRoot, "vault", "orchestrator-state.json");
  try {
    const state = JSON.parse(await readFile(path, "utf-8"));
    const last = state?.schemaEvolutionPipeline?.lastRun;
    if (!last) return false;
    const now = new Date();
    const lastDate = new Date(last);
    return now.getFullYear() === lastDate.getFullYear() && now.getMonth() === lastDate.getMonth();
  } catch { return false; }
}

async function main() {
  initLogger(VAULT_ROOT);
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!force && !dryRun && await alreadyRanThisMonth(VAULT_ROOT)) {
    console.error("[schema-evolve] Already ran this month; use --force to override.");
    return;
  }

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  await proposeSchemaChanges(vault, provider, model, dryRun);
}

const isMain = process.argv[1]?.endsWith("schema-evolve-cli.js");
if (isMain) {
  main().catch((err) => {
    console.error("[schema-evolve] Fatal:", err);
    process.exit(1);
  });
}
