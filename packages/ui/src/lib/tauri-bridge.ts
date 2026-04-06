import { invoke } from "@tauri-apps/api/core";

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

// Detect Tauri runtime — exported for use by logger.ts
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Dev API server base URL
const API_BASE = "http://localhost:3001/api";

// --- Transport layer (exported for logger.ts) ---

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
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

export async function getLlmConfig(): Promise<{ provider: string; model: string; apiKey?: string; baseUrl?: string }> {
  if (isTauri) return tauriInvoke("get_llm_config");
  return apiGet("/llm-config");
}

export async function saveLlmSettings(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<void> {
  if (isTauri) return tauriInvoke("save_llm_settings", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
  await apiPost("/save-llm-settings", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ValidateModelsResult {
  valid: boolean;
  error?: string;
  models: ModelInfo[];
}

export async function validateAndListModels(provider: string, apiKey?: string, baseUrl?: string): Promise<ValidateModelsResult> {
  if (isTauri) return tauriInvoke("validate_and_list_models", { provider, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
  return apiPost("/validate-models", { provider, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}

export interface TestModelResult {
  success: boolean;
  response?: string;
  error?: string;
}

export async function testModel(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<TestModelResult> {
  if (isTauri) return tauriInvoke("test_model", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
  return apiPost("/test-model", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}

export async function getVaultPath(): Promise<string> {
  if (isTauri) return tauriInvoke("get_vault_path");
  const result = await apiGet<{ path: string }>("/vault-path");
  return result.path;
}

export async function getProjectPath(): Promise<string> {
  if (isTauri) return tauriInvoke("get_project_path");
  const result = await apiGet<{ path: string }>("/project-path");
  return result.path;
}

export interface ClaudeDesktopStatus {
  installed: boolean;
  connected: boolean;
  configPath: string;
}

export async function getClaudeDesktopStatus(): Promise<ClaudeDesktopStatus> {
  if (isTauri) return tauriInvoke("get_claude_desktop_status");
  return apiGet("/claude-desktop-status");
}

export async function connectClaudeDesktop(): Promise<void> {
  if (isTauri) return tauriInvoke("connect_claude_desktop");
  await apiPost("/claude-desktop-connect", {});
}

export async function disconnectClaudeDesktop(): Promise<void> {
  if (isTauri) return tauriInvoke("disconnect_claude_desktop");
  await apiPost("/claude-desktop-disconnect", {});
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

export interface SkillData {
  name: string;
  description: string;
  schedule: string | null;
  lookback: string;
  requires: { bins: string[]; env: string[] };
  body: string;
  eligible: boolean;
  missing: string[];
  lastRunAt: string | null;
  lastStatus: string;
  entriesCollected: number;
  lastError?: string;
  isBuiltin: boolean;
}

export async function getSkills(): Promise<SkillData[]> {
  if (isTauri) return tauriInvoke("get_skills");
  return apiGet("/skills");
}

export async function installDependency(dep: string): Promise<{ success: boolean; output: string }> {
  if (isTauri) return tauriInvoke("install_dependency", { dep });
  return apiPost("/install-dependency", { dep });
}

export async function installSkill(repo: string): Promise<string> {
  if (isTauri) return tauriInvoke("install_skill", { repo });
  const result = await apiPost<{ output: string }>("/skills/install", { repo });
  return result.output;
}

export async function removeSkill(name: string): Promise<void> {
  if (isTauri) return tauriInvoke("remove_skill", { name });
  const res = await fetch(`${API_BASE}/skills/${name}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function runSkillNow(name: string): Promise<string> {
  if (isTauri) return tauriInvoke("run_skill", { name });
  const result = await apiPost<{ output: string }>(`/skills/${name}/run`, {});
  return result.output;
}

// --- Orchestrator ---

export interface OrchestratorSchedule {
  time: string;
  days: string[];
}

export interface OrchestratorCollector {
  enabled: boolean;
  schedules: OrchestratorSchedule[];
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  nextRun: string | null;
}

export interface OrchestratorDreamPipeline {
  autoTrigger: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  collectorsCompletedToday: string[];
}

export interface OrchestratorStatus {
  running: boolean;
  lastHeartbeat: string;
  collectors: Record<string, OrchestratorCollector>;
  dreamPipeline: OrchestratorDreamPipeline;
}

export async function getOrchestratorStatus(): Promise<OrchestratorStatus> {
  if (isTauri) return tauriInvoke("get_orchestrator_status");
  return apiGet("/orchestrator-status");
}

export async function updateSchedule(skill: string, schedules: OrchestratorSchedule[], enabled: boolean): Promise<void> {
  if (isTauri) return tauriInvoke("update_schedule", { skill, schedules, enabled });
  await apiPost("/orchestrator-schedule", { skill, schedules, enabled });
}

export async function triggerOrchestratorRun(target: string): Promise<string> {
  if (isTauri) return tauriInvoke("trigger_orchestrator_run", { target });
  const result = await apiPost<{ output: string }>("/orchestrator-run", { target });
  return result.output;
}

export async function toggleOrchestratorSchedule(target: string, enabled: boolean): Promise<void> {
  if (isTauri) return tauriInvoke("toggle_orchestrator_schedule", { target, enabled });
  await apiPost("/orchestrator-toggle", { target, enabled });
}
