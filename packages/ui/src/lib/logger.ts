/**
 * Simple structured logger that writes to the dev server / Tauri backend.
 * Logs are appended to ~/OpenPulseAI/vault/logs/YYYY-MM-DD.jsonl
 */

const API_BASE = "http://localhost:3001/api";
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("append_log", { entry });
    } else {
      await fetch(`${API_BASE}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
    }
  } catch {
    // Don't throw on log failure — logging should never break the app
    console.warn("[logger] Failed to write log:", message);
  }
}

export async function getLogs(level?: LogLevel): Promise<LogEntry[]> {
  try {
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("get_logs", { level: level ?? null });
    }
    const url = level ? `${API_BASE}/logs?level=${level}` : `${API_BASE}/logs`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}
