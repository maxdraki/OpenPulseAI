/**
 * File-based logger that writes to vault/logs/YYYY-MM-DD.jsonl.
 * Used by MCP server, skills runner, and dream pipeline to log
 * activity visible in the UI's Logs page.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  detail?: string;
}

let logsDir: string | null = null;

export function initLogger(vaultRoot: string): void {
  logsDir = join(vaultRoot, "vault", "logs");
}

export async function vaultLog(level: LogLevel, message: string, detail?: string): Promise<void> {
  if (!logsDir) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    detail,
  };

  try {
    await mkdir(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `${date}.jsonl`);
    await appendFile(logFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never throw from logging
    console.error(`[logger] Failed to write: ${message}`);
  }
}
