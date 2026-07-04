/**
 * Simple structured logger that writes to the dev server / Tauri backend.
 * Logs are appended to ~/OpenPulseAI/vault/logs/YYYY-MM-DD.jsonl
 *
 * LogLevel/LogEntry types intentionally duplicated from @openpulse/core
 * (browser can't import Node packages). Keep in sync with core/src/logger.ts.
 */
import { apiPost, apiGet } from "./tauri-bridge.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  detail?: string;
}

export async function log(level: LogLevel, message: string, detail?: string): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    detail,
  };

  try {
    // Routed through apiPost (not a raw fetch) so it picks up the same
    // Authorization header as every other /api call — a bare fetch here
    // would 401 once the dev-server's bearer guard is on by default. Same
    // path under Tauri now too (see tauri-bridge.ts's resolveApiBase) — the
    // desktop app talks to this same local server over fetch.
    await apiPost("/logs", entry as unknown as Record<string, unknown>);
  } catch {
    console.warn("[logger] Failed to write log:", message);
  }
}

export async function getLogs(level?: LogLevel): Promise<LogEntry[]> {
  try {
    const path = level ? `/logs?level=${level}` : `/logs`;
    return await apiGet(path);
  } catch {
    return [];
  }
}
