#!/usr/bin/env node
import { readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Vault, loadConfig, listThemes, createProvider, initLogger, vaultLog } from "@openpulse/core";
import type { ActivityEntry } from "@openpulse/core";
import { classifyEntries } from "./classify.js";
import { synthesizeToPending } from "./synthesize.js";
import { archiveProcessedHotFiles } from "./archive.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  console.error("[dream] Starting Dream Pipeline...");

  const config = await loadConfig(VAULT_ROOT);
  initLogger(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  await vaultLog("info", "Dream pipeline started");

  const provider = createProvider(config);
  const model = config.llm.model;

  const entries = await readHotEntries(vault);
  if (entries.length === 0) {
    console.error("[dream] No hot entries to process. Exiting.");
    return;
  }
  console.error(`[dream] Found ${entries.length} hot entries.`);

  const themes = await listThemes(vault);
  const allThemes = [...new Set([...config.themes, ...themes])];

  const classified = await classifyEntries(entries, allThemes, provider, model);
  console.error(`[dream] Classified ${classified.length} entries.`);

  let pending: Awaited<ReturnType<typeof synthesizeToPending>>;
  try {
    pending = await synthesizeToPending(vault, classified, provider, model);
  } catch (err) {
    console.error("[dream] Synthesis failed — hot files preserved for retry:", err);
    await vaultLog("error", "Synthesis failed, hot files NOT archived", String(err));
    throw err;
  }
  console.error(`[dream] Created ${pending.length} pending update(s). Review in the Control Center.`);

  await generateIndex(vault);
  const themeNames = pending.map((p) => p.theme).join(", ");
  await appendLog(vault, "dream", `${entries.length} entries → ${pending.length} updates (${themeNames})`);

  await archiveProcessedHotFiles(vault);
  await vaultLog("info", "Dream pipeline complete", `${classified.length} entries → ${pending.length} pending update(s)`);
  console.error("[dream] Hot files archived. Dream complete.");
}

async function readHotEntries(vault: Vault): Promise<ActivityEntry[]> {
  const files = await readdir(vault.hotDir);
  const entries: ActivityEntry[] = [];

  for (const file of files) {
    if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;

    const content = await readFile(join(vault.hotDir, file), "utf-8");
    const blocks = content.split(/\n---\n/).filter((b) => b.trim());

    for (const block of blocks) {
      const tsMatch = block.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m);
      const themeMatch = block.match(/^\*\*Theme:\*\*\s*(.+)/m);
      const logLines = block
        .split("\n")
        .filter(
          (l) =>
            !l.startsWith("## ") &&
            !l.startsWith("**Theme:") &&
            !l.startsWith("**Source:") &&
            l.trim()
        );

      if (tsMatch && logLines.length > 0) {
        entries.push({
          timestamp: tsMatch[1],
          log: logLines.join("\n").trim(),
          theme: themeMatch?.[1],
        });
      }
    }
  }

  // Also read ingested documents
  const ingestDir = join(vault.hotDir, "ingest");
  try {
    const ingestFiles = await readdir(ingestDir);
    for (const file of ingestFiles) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(ingestDir, file);
      const content = await readFile(filePath, "utf-8");
      const fileStat = await stat(filePath);
      entries.push({
        timestamp: fileStat.mtime.toISOString(),
        log: content,
        theme: "ingested",
        source: file.replace(/\.md$/, ""),
      });
    }
  } catch { /* ingest dir may not exist */ }

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function generateIndex(vault: Vault): Promise<void> {
  const files = await readdir(vault.warmDir);
  const themeFiles = files.filter(
    (f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md" && !f.startsWith("_")
  );

  type ThemeEntry = { name: string; summary: string; lastUpdated: string };

  const themes = await Promise.all(themeFiles.map(async (file) => {
    const content = await readFile(join(vault.warmDir, file), "utf-8");
    const lines = content.split("\n");

    let lastUpdated = "";
    if (lines[0] === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") break;
        const match = lines[i].match(/^lastUpdated:\s*(.+)/);
        if (match) { lastUpdated = match[1].trim(); break; }
      }
    }

    let summary = "";
    const statusIdx = lines.findIndex((l) => l.trim() === "## Current Status");
    if (statusIdx !== -1) {
      for (let i = statusIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith("#")) {
          summary = trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
          break;
        }
      }
    }

    const name = file.replace(/\.md$/, "");
    return { name, summary, lastUpdated } as ThemeEntry;
  }));

  // Sort by lastUpdated descending
  themes.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));

  const formatDate = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    } catch {
      return iso;
    }
  };

  const listLines = themes
    .map((t) => `- [[${t.name}]] — ${t.summary}${t.lastUpdated ? ` (${formatDate(t.lastUpdated)})` : ""}`)
    .join("\n");

  const now = new Date().toISOString();
  const indexContent = `# OpenPulse Knowledge Base\n\n${listLines}\n\nLast updated: ${now} | ${themes.length} themes\n`;

  await writeFile(join(vault.warmDir, "index.md"), indexContent, "utf-8");
}

export async function appendLog(vault: Vault, type: string, detail: string): Promise<void> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const line = `## [${timestamp}] ${type} | ${detail}\n`;
  await appendFile(join(vault.warmDir, "log.md"), line, "utf-8");
}

main().catch((error) => {
  console.error("[dream] Fatal error:", error);
  process.exit(1);
});
