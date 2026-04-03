import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault.js";
import type { ActivityEntry } from "./types.js";

export async function appendActivity(
  vault: Vault,
  entry: ActivityEntry
): Promise<void> {
  const date = entry.timestamp.slice(0, 10);
  const logPath = vault.dailyLogPath(date);
  const line = formatEntry(entry);
  await appendFile(logPath, line, "utf-8");
}

function formatEntry(entry: ActivityEntry): string {
  const parts = [`## ${entry.timestamp}`];
  if (entry.theme) parts.push(`**Theme:** ${entry.theme}`);
  if (entry.source) parts.push(`**Source:** ${entry.source}`);
  parts.push("", entry.log, "", "---", "");
  return parts.join("\n");
}

export async function saveIngestedDocument(
  vault: Vault,
  filename: string,
  content: string
): Promise<void> {
  const filePath = join(vault.ingestDir, filename);
  await writeFile(filePath, content, "utf-8");
}
