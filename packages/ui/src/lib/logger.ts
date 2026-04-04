/**
 * Simple structured logger that writes to the dev server / Tauri backend.
 * Logs are appended to ~/OpenPulseAI/vault/logs/YYYY-MM-DD.jsonl
 *
 * LogLevel/LogEntry types intentionally duplicated from @openpulse/core
 * (browser can't import Node packages). Keep in sync with core/src/logger.ts.
 */
import { isTauri, tauriInvoke, apiPost, apiGet } from "./tauri-bridge.js";

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
    if (isTauri) {
      await tauriInvoke("append_log", { entry });
    } else {
      await fetch(`http://localhost:3001/api/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
    }
  } catch {
    console.warn("[logger] Failed to write log:", message);
  }
}

export async function getLogs(level?: LogLevel): Promise<LogEntry[]> {
  try {
    if (isTauri) {
      return tauriInvoke("get_logs", { level: level ?? null });
    }
    const url = level ? `http://localhost:3001/api/logs?level=${level}` : `http://localhost:3001/api/logs`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}
