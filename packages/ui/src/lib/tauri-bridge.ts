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

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    // Use the global Tauri API (available when withGlobalTauri is enabled)
    const tauriInvoke = (window as any).__TAURI__.core.invoke;
    return tauriInvoke(cmd, args);
  }
  return mockInvoke(cmd, args) as T;
}

// Mock implementations for browser development
function mockInvoke(cmd: string, _args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "get_vault_health":
      return { hotCount: 3, warmCount: 5, pendingCount: 2, vaultExists: true };
    case "list_pending_updates":
      return [
        {
          id: "mock-1",
          theme: "project-auth",
          proposedContent: "## Current Status\n\nLogin page refactored. JWT tokens implemented.",
          previousContent: "## Current Status\n\nLogin page in progress.",
          entries: [{ timestamp: "2026-04-03T10:00:00Z", log: "Refactored login page" }],
          createdAt: "2026-04-03T02:00:00Z",
          status: "pending",
        },
        {
          id: "mock-2",
          theme: "hiring",
          proposedContent: "## Current Status\n\nSenior engineer role posted. 3 candidates in pipeline.",
          previousContent: null,
          entries: [{ timestamp: "2026-04-03T11:00:00Z", log: "Posted job listing" }],
          createdAt: "2026-04-03T02:00:00Z",
          status: "pending",
        },
      ];
    case "approve_update":
      return undefined;
    case "reject_update":
      return undefined;
    case "trigger_dream":
      return "[dream] No hot entries to process. Exiting.";
    case "get_llm_config":
      return { provider: "anthropic", model: "claude-sonnet-4-5-20250929" };
    case "save_llm_settings":
      return undefined;
    case "get_vault_path":
      return "~/OpenPulseAI";
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

export async function getVaultHealth(): Promise<VaultHealth> {
  return invoke("get_vault_health");
}

export async function listPendingUpdates(): Promise<PendingUpdate[]> {
  return invoke("list_pending_updates");
}

export async function approveUpdate(id: string, editedContent?: string): Promise<void> {
  return invoke("approve_update", { id, editedContent: editedContent ?? null });
}

export async function rejectUpdate(id: string): Promise<void> {
  return invoke("reject_update", { id });
}

export async function triggerDream(): Promise<string> {
  return invoke("trigger_dream");
}

export async function getLlmConfig(): Promise<{ provider: string; model: string }> {
  return invoke("get_llm_config");
}

export async function saveLlmSettings(provider: string, model: string, apiKey?: string): Promise<void> {
  return invoke("save_llm_settings", { provider, model, apiKey: apiKey ?? null });
}

export async function getVaultPath(): Promise<string> {
  return invoke("get_vault_path");
}
