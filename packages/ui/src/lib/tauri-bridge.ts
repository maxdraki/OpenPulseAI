// Types matching the core package
export interface VaultHealth {
  hotCount: number;
  warmCount: number;
  pendingCount: number;
  vaultExists: boolean;
}

export interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: Array<{ timestamp: string; log: string }>;
  createdAt: string;
  status: string;
}

// Detect Tauri runtime (window.__TAURI__ is injected by the Tauri webview)
const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

// Dev API server base URL
const API_BASE = "http://localhost:3001/api";

// --- Transport layer ---

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = (window as any).__TAURI__.core.invoke;
  return invoke(cmd, args);
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// --- Public API ---

export async function getVaultHealth(): Promise<VaultHealth> {
  if (isTauri) return tauriInvoke("get_vault_health");
  return apiGet("/vault-health");
}

export async function listPendingUpdates(): Promise<PendingUpdate[]> {
  if (isTauri) return tauriInvoke("list_pending_updates");
  return apiGet("/pending-updates");
}

export async function approveUpdate(id: string, editedContent?: string): Promise<void> {
  if (isTauri) return tauriInvoke("approve_update", { id, editedContent: editedContent ?? null });
  await apiPost("/approve-update", { id, editedContent: editedContent ?? null });
}

export async function rejectUpdate(id: string): Promise<void> {
  if (isTauri) return tauriInvoke("reject_update", { id });
  await apiPost("/reject-update", { id });
}

export async function triggerDream(): Promise<string> {
  if (isTauri) return tauriInvoke("trigger_dream");
  const result = await apiPost<{ output: string }>("/trigger-dream", {});
  return result.output;
}

export async function getLlmConfig(): Promise<{ provider: string; model: string }> {
  if (isTauri) return tauriInvoke("get_llm_config");
  return apiGet("/llm-config");
}

export async function saveLlmSettings(provider: string, model: string, apiKey?: string): Promise<void> {
  if (isTauri) return tauriInvoke("save_llm_settings", { provider, model, apiKey: apiKey ?? null });
  await apiPost("/save-llm-settings", { provider, model, apiKey: apiKey ?? null });
}

export async function getVaultPath(): Promise<string> {
  if (isTauri) return tauriInvoke("get_vault_path");
  const result = await apiGet<{ path: string }>("/vault-path");
  return result.path;
}

export interface HotEntry {
  timestamp: string;
  log: string;
  theme?: string;
  source?: string;
}

export interface WarmTheme {
  theme: string;
  content: string;
  lastUpdated: string;
}

export async function getHotEntries(): Promise<HotEntry[]> {
  if (isTauri) return tauriInvoke("get_hot_entries");
  return apiGet("/hot-entries");
}

export async function getWarmThemes(): Promise<WarmTheme[]> {
  if (isTauri) return tauriInvoke("get_warm_themes");
  return apiGet("/warm-themes");
}

export interface SourceData {
  name: string;
  command: string;
  args: string[];
  schedule: string;
  lookback: string;
  template: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string;
  entriesCollected: number;
  lastError?: string;
}

export interface SourceInput {
  name: string;
  command: string;
  args: string[];
  schedule: string;
  lookback: string;
  template?: string;
  enabled: boolean;
  env?: Record<string, string>;
}

export async function getSources(): Promise<SourceData[]> {
  if (isTauri) return tauriInvoke("get_sources");
  return apiGet("/sources");
}

export async function addSource(source: SourceInput): Promise<void> {
  if (isTauri) return tauriInvoke("add_source", { source });
  await apiPost("/sources", source as any);
}

export async function updateSource(name: string, source: SourceInput): Promise<void> {
  if (isTauri) return tauriInvoke("update_source", { name, source });
  const res = await fetch(`${API_BASE}/sources/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function deleteSource(name: string): Promise<void> {
  if (isTauri) return tauriInvoke("delete_source", { name });
  const res = await fetch(`${API_BASE}/sources/${name}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function testSourceConnection(name: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (isTauri) return tauriInvoke("test_source", { name });
  return apiPost(`/sources/${name}/test`, {});
}

export async function triggerSourceCollect(name: string): Promise<string> {
  if (isTauri) return tauriInvoke("trigger_collect", { name });
  const result = await apiPost<{ output: string }>(`/sources/${name}/collect`, {});
  return result.output;
}
