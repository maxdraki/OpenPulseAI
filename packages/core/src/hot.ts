import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault.js";
import type { ActivityEntry } from "./types.js";

/**
 * Shared parser for the block format written by `formatEntry`. The same format
 * is produced in one place here and consumed in several (dream pipeline,
 * dev-server `/api/hot-entries`, and the duplicate-detection guard below), so
 * parsing lives with the formatter to stay in sync.
 */
export interface ParsedActivityBlock {
  timestamp: string;
  log: string;
  theme?: string;
  source?: string;
}

const TIMESTAMP_RE = /^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m;
const THEME_RE = /^\*\*Theme:\*\*\s*(.+)/m;
const SOURCE_RE = /^\*\*Source:\*\*\s*(.+)/m;

/**
 * Unambiguous entry-record delimiter. The legacy delimiter was a bare `\n---\n`
 * line, which collides with entry bodies that legitimately contain a horizontal
 * rule or YAML frontmatter (LLM-authored summaries do this routinely), silently
 * fracturing one entry into multiple malformed blocks. An HTML comment marker
 * can't collide with normal markdown content.
 */
export const ENTRY_MARKER = "<!-- openpulse:entry -->";
const ENTRY_MARKER_RE = /\n<!-- openpulse:entry -->\n/;
const LEGACY_DELIMITER_RE = /\n---\n/;

export function parseActivityBlock(block: string): ParsedActivityBlock | null {
  const tsMatch = block.match(TIMESTAMP_RE);
  if (!tsMatch) return null;
  const logLines = block
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("## ") &&
        !l.startsWith("**Theme:") &&
        !l.startsWith("**Source:") &&
        l.trim()
    );
  if (logLines.length === 0) return null;
  const themeMatch = block.match(THEME_RE);
  const sourceMatch = block.match(SOURCE_RE);
  return {
    timestamp: tsMatch[1],
    log: logLines.join("\n").trim(),
    theme: themeMatch?.[1],
    source: sourceMatch?.[1],
  };
}

/**
 * Splits raw hot-file content into individual entry-record strings.
 *
 * Parses the new unambiguous marker first; a file (or a legacy tail segment
 * within it) that contains no new marker at all falls back to the old bare
 * `\n---\n` splitting so pre-existing vault files keep parsing correctly.
 *
 * Known limitation: a file that mixes legacy entries (written before this
 * delimiter change) with newly-appended marker-delimited entries will only
 * legacy-split the portion *before* the first marker — if that pre-marker
 * portion itself concatenates multiple legacy entries, they're still split
 * correctly (no marker present in that span to short-circuit on), but this
 * cannot be done losslessly if a marker-delimited entry's own body happens to
 * contain `\n---\n` while sharing a file with legacy entries. This is the same
 * inherent ambiguity the new marker exists to eliminate; it can only be fully
 * removed once no legacy-delimited files remain (e.g. after they're archived).
 */
export function splitHotFileBlocks(fileContent: string): string[] {
  if (!fileContent.includes(ENTRY_MARKER)) {
    return fileContent.split(LEGACY_DELIMITER_RE);
  }
  return fileContent.split(ENTRY_MARKER_RE);
}

/** Re-serializes entry blocks back into hot-file content using the new marker. */
export function joinHotFileBlocks(blocks: string[]): string {
  if (blocks.length === 0) return "";
  return blocks.join(`\n\n${ENTRY_MARKER}\n\n`) + `\n\n${ENTRY_MARKER}\n\n`;
}

export function parseActivityBlocks(fileContent: string): ParsedActivityBlock[] {
  return splitHotFileBlocks(fileContent)
    .filter((b) => b.trim())
    .map(parseActivityBlock)
    .filter((b): b is ParsedActivityBlock => b !== null);
}

export async function appendActivity(
  vault: Vault,
  entry: ActivityEntry
): Promise<void> {
  const date = entry.timestamp.slice(0, 10);
  const logPath = vault.dailyLogPath(date);
  if (await isDuplicateEntry(logPath, entry)) {
    return;
  }
  const line = formatEntry(entry);
  await appendFile(logPath, line, "utf-8");
}

function formatEntry(entry: ActivityEntry): string {
  const parts = [`## ${entry.timestamp}`];
  if (entry.theme) parts.push(`**Theme:** ${entry.theme}`);
  if (entry.source) parts.push(`**Source:** ${entry.source}`);
  parts.push("", entry.log, "", ENTRY_MARKER, "");
  return parts.join("\n");
}

// Protects against duplicate writes when a collector fires from both the missed-run
// catch-up and its regular schedule in quick succession, or when re-runs overlap
// windows. Compares (source, log-content) against entries in the same day file
// whose timestamp is within 60s of the new one.
const DUP_WINDOW_MS = 60_000;
// Duplicates always cluster at the tail (they're the most recent writes). Scanning
// only the last handful keeps this cheap even for days with thousands of entries.
const DUP_SCAN_TAIL_BLOCKS = 8;

async function isDuplicateEntry(logPath: string, entry: ActivityEntry): Promise<boolean> {
  let existing: string;
  try {
    existing = await readFile(logPath, "utf-8");
  } catch {
    return false;
  }
  const entryTs = Date.parse(entry.timestamp);
  if (!Number.isFinite(entryTs)) return false;

  const blocks = parseActivityBlocks(existing).slice(-DUP_SCAN_TAIL_BLOCKS);
  const normalized = entry.log.trim();
  const entrySource = entry.source ?? "";
  for (const block of blocks) {
    const prevTs = Date.parse(block.timestamp);
    if (!Number.isFinite(prevTs)) continue;
    if (Math.abs(entryTs - prevTs) > DUP_WINDOW_MS) continue;
    if ((block.source ?? "") !== entrySource) continue;
    if (block.log.trim() === normalized) return true;
  }
  return false;
}

export async function saveIngestedDocument(
  vault: Vault,
  filename: string,
  content: string
): Promise<void> {
  // Strip path separators and leading dots to prevent directory traversal.
  // Then verify the resolved path is still inside the ingest directory.
  const safeFilename = filename.replace(/[/\\]/g, "_").replace(/^\.+/, "_").slice(0, 255);
  if (!safeFilename) throw new Error("Invalid filename: empty after sanitization");
  const filePath = join(vault.ingestDir, safeFilename);
  if (!filePath.startsWith(vault.ingestDir + "/")) {
    throw new Error("Invalid filename: path traversal attempt blocked");
  }
  await writeFile(filePath, content, "utf-8");
}
