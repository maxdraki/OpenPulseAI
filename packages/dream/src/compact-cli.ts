#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Vault, loadConfig, createProvider, initLogger, vaultLog,
  listThemes, readTheme,
} from "@openpulse/core";
import type { LlmProvider, PendingUpdate } from "@openpulse/core";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const VERBATIM_LIMIT = 14;
const SKIP_DAYS = 7;

export interface DatedSection { date: string; body: string; }

export function bucketActivityLog(sections: DatedSection[]): { verbatim: DatedSection[]; grouped: Record<string, DatedSection[]> } {
  // Assumes sections are sorted most-recent-first.
  const verbatim = sections.slice(0, VERBATIM_LIMIT);
  const older = sections.slice(VERBATIM_LIMIT);
  const grouped: Record<string, DatedSection[]> = {};
  for (const s of older) {
    const week = isoWeek(s.date);
    (grouped[week] ??= []).push(s);
  }
  return { verbatim, grouped };
}

function isoWeek(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z");
  const y = d.getUTCFullYear();
  const t = new Date(Date.UTC(y, 0, 1));
  const day = t.getUTCDay() || 7;
  const week = Math.ceil((((d.getTime() - t.getTime()) / 86400000) + day) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

export async function parseProjectPage(content: string): Promise<{ currentStatus: string; sections: DatedSection[] }> {
  const activityMatch = content.match(/##\s+Activity Log\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  const activityBody = activityMatch?.[1] ?? "";
  const statusMatch = content.match(/##\s+Current Status\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  const currentStatus = statusMatch?.[1]?.trim() ?? "";

  const sections: DatedSection[] = [];
  const re = /###\s+(\d{4}-\d{2}-\d{2})\b[^\n]*\n([\s\S]*?)(?=\n###\s+\d{4}-\d{2}-\d{2}|$)/g;
  for (const m of activityBody.matchAll(re)) {
    sections.push({ date: m[1], body: m[2].trim() });
  }
  sections.sort((a, b) => b.date.localeCompare(a.date));
  return { currentStatus, sections };
}

async function compactProject(vault: Vault, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;
  const { currentStatus, sections } = await parseProjectPage(doc.content);
  if (sections.length <= VERBATIM_LIMIT) return false;

  const { verbatim, grouped } = bucketActivityLog(sections);
  const groupedText = Object.entries(grouped)
    .map(([week, items]) => `#### ${week}\n${items.map((i) => `- ${i.date}: ${i.body.replace(/\n/g, " ").slice(0, 300)}`).join("\n")}`)
    .join("\n\n");

  const response = await provider.complete({
    model,
    temperature: 0.1,
    maxTokens: 2048,
    prompt: `You are compacting a project wiki page titled "${theme}".

Current Status:
${currentStatus}

Older Activity Log sections grouped by ISO week:
${groupedText}

Produce:
(a) A rewritten ## Current Status reflecting the trajectory (not just the most recent entry).
(b) A ## History section: one bullet per ISO week summarizing key events, preserving any ^[src:] markers.

Return JSON: {"current_status": "...", "history": "..."}`,
  });

  let parsed: { current_status: string; history: string };
  try {
    let jsonText = response.trim();
    if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(jsonText);
  } catch {
    await vaultLog("warn", `[compact] LLM parse failed for ${theme}`);
    return false;
  }

  const verbatimText = verbatim.map((s) => `### ${s.date}\n${s.body}`).join("\n\n");
  const newContent = `## Current Status\n${parsed.current_status.trim()}\n\n## Activity Log\n\n${verbatimText}\n\n## History\n${parsed.history.trim()}\n`;

  const update: PendingUpdate = {
    id: randomUUID(),
    theme,
    proposedContent: newContent,
    previousContent: doc.content,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type: "project",
    compactionType: "scheduled",
    sources: doc.sources,
    related: doc.related,
    created: doc.created,
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  return true;
}

async function compactConcept(vault: Vault, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;

  const factsPath = join(vault.warmDir, "_facts", `${theme}.jsonl`);
  let facts = "";
  try { facts = await readFile(factsPath, "utf-8"); } catch { return false; }
  if (!facts.trim()) return false;

  const response = await provider.complete({
    model,
    temperature: 0.1,
    maxTokens: 2048,
    prompt: `You are compacting a ${doc.type} wiki page titled "${theme}".

Current page:
${doc.content}

All extracted facts (includes older and newer, JSON per line):
${facts}

Rewrite the page. Prefer newer facts where they contradict older ones. Preserve all ^[src:] citations. Note unresolved conflicts with ^[ambiguous].

Return ONLY the Markdown content, no fences.`,
  });

  const update: PendingUpdate = {
    id: randomUUID(),
    theme,
    proposedContent: response,
    previousContent: doc.content,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type: doc.type,
    compactionType: "scheduled",
    sources: doc.sources,
    related: doc.related,
    created: doc.created,
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  return true;
}

export async function compactTheme(vault: Vault, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;
  if (doc.type === "concept" || doc.type === "entity") return compactConcept(vault, theme, provider, model);
  return compactProject(vault, theme, provider, model);
}

async function loadOrchestratorState(): Promise<any> {
  const path = join(VAULT_ROOT, "vault", "orchestrator-state.json");
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch { return null; }
}

async function saveOrchestratorState(state: any): Promise<void> {
  const path = join(VAULT_ROOT, "vault", "orchestrator-state.json");
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

async function main() {
  initLogger(VAULT_ROOT);
  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  const explicitThemes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  const state = await loadOrchestratorState();
  const perThemeLastCompacted: Record<string, string> = state?.compactionPipeline?.perThemeLastCompacted ?? {};
  const sizeQueue: string[] = state?.compactionPipeline?.sizeQueue ?? [];

  let themes: string[];
  if (explicitThemes.length > 0) {
    themes = explicitThemes;
  } else {
    const allThemes = await listThemes(vault);
    themes = [...new Set([...sizeQueue, ...allThemes])];
    if (!force) {
      themes = themes.filter((t) => {
        if (sizeQueue.includes(t)) return true;
        const last = perThemeLastCompacted[t];
        if (!last) return true;
        const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
        return days >= SKIP_DAYS;
      });
    }
  }

  await vaultLog("info", `[compact] Starting compaction for ${themes.length} theme(s)`);

  let compacted = 0;
  for (const theme of themes) {
    try {
      const did = await compactTheme(vault, theme, provider, model);
      if (did) {
        compacted++;
        perThemeLastCompacted[theme] = new Date().toISOString();
      }
    } catch (err) {
      await vaultLog("error", `[compact] Failed for ${theme}`, String(err));
    }
  }

  if (state) {
    state.compactionPipeline = state.compactionPipeline ?? {};
    state.compactionPipeline.perThemeLastCompacted = perThemeLastCompacted;
    state.compactionPipeline.sizeQueue = [];
    await saveOrchestratorState(state);
  }

  await vaultLog("info", `[compact] Done — ${compacted} pending update(s) created`);
}

// Only run main when executed directly, not when imported from tests
const isMain = process.argv[1]?.endsWith("compact-cli.js");
if (isMain) {
  main().catch((err) => {
    console.error("[compact] Fatal:", err);
    process.exit(1);
  });
}
