#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Vault, loadConfig, createProvider, initLogger, vaultLog,
  listThemes, readTheme, stripCodeFences,
  loadState, updateStateSection,
} from "@openpulse/core";
import type { LlmProvider, PendingUpdate, ThemeDocument, ThemeType } from "@openpulse/core";
import { readFactsFile, activeFacts, compactFactStore } from "./facts.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const VERBATIM_LIMIT = 14;
const SKIP_DAYS = 7;

/** Build a scheduled-compaction PendingUpdate preserving the source doc's metadata. */
function buildCompactionUpdate(doc: ThemeDocument, theme: string, type: ThemeType | undefined, proposedContent: string): PendingUpdate {
  return {
    id: randomUUID(),
    theme,
    proposedContent,
    previousContent: doc.content,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type,
    compactionType: "scheduled",
    sources: doc.sources,
    related: doc.related,
    created: doc.created,
  };
}

async function writePending(vault: Vault, update: PendingUpdate): Promise<void> {
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
}

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
    parsed = JSON.parse(stripCodeFences(response));
  } catch {
    await vaultLog("warn", `[compact] LLM parse failed for ${theme}`);
    return false;
  }

  const verbatimText = verbatim.map((s) => `### ${s.date}\n${s.body}`).join("\n\n");
  const newContent = `## Current Status\n${parsed.current_status.trim()}\n\n## Activity Log\n\n${verbatimText}\n\n## History\n${parsed.history.trim()}\n`;

  await writePending(vault, buildCompactionUpdate(doc, theme, "project", newContent));
  return true;
}

async function compactConcept(vault: Vault, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;

  const factsPath = join(vault.warmDir, "_facts", `${theme}.jsonl`);
  const archivePath = join(vault.warmDir, "_facts", `${theme}.archive.jsonl`);

  // Housekeeping: once the live fact file grows past the threshold, move
  // superseded facts out to the archive (never dropped, just relocated) so
  // this prompt — and every future pass-2 resynthesis — only pays for
  // active facts (see facts.ts's compactFactStore).
  await compactFactStore(factsPath, archivePath);

  const allFacts = await readFactsFile(factsPath);
  const active = activeFacts(allFacts);
  if (active.length === 0) return false;
  const factsText = active.map((f) => JSON.stringify(f)).join("\n") + "\n";

  const response = await provider.complete({
    model,
    temperature: 0.1,
    maxTokens: 2048,
    prompt: `You are compacting a ${doc.type} wiki page titled "${theme}".

Current page:
${doc.content}

All active extracted facts (superseded facts have already been resolved and excluded — JSON per line):
${factsText}

Rewrite the page. Preserve all ^[src:] citations. Note unresolved conflicts with ^[ambiguous].

Return ONLY the Markdown content, no fences.`,
  });

  await writePending(vault, buildCompactionUpdate(doc, theme, doc.type, response));
  return true;
}

export async function compactTheme(vault: Vault, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;
  if (doc.type === "concept" || doc.type === "entity") return compactConcept(vault, theme, provider, model);
  return compactProject(vault, theme, provider, model);
}

// State I/O is delegated to the shared atomic helpers in @openpulse/core so
// the subprocess cannot crash the orchestrator with a tmp-file rename race.
// The final write uses updateStateSection (scoped read-modify-write, re-reads
// immediately before writing) rather than a whole-object saveState, since this
// CLI's run can take minutes (one LLM call per theme) — long enough for the
// orchestrator process to have advanced collector/dream/lint state several
// times in the meantime. A whole-object save at the end would silently
// clobber all of that with this process's stale in-memory copy. See the
// residual-race note on updateStateSection's doc comment.

async function main() {
  initLogger(VAULT_ROOT);
  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  const explicitThemes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  // loadState uses core's typed defaults, so these sub-states are always well-formed
  const state = await loadState(VAULT_ROOT);
  const perThemeLastCompacted = state.compactionPipeline.perThemeLastCompacted;
  const sizeQueue = state.compactionPipeline.sizeQueue;

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

  await updateStateSection(VAULT_ROOT, "compactionPipeline", (cp) => ({
    ...cp,
    perThemeLastCompacted,
    sizeQueue: [],
  }));

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
