import { invoke } from "@tauri-apps/api/core";

// Types matching the core package
export interface VaultHealth {
  hotCount: number;
  warmCount: number;
  pendingCount: number;
  vaultExists: boolean;
}

export interface DreamUsageTotals {
  calls: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DreamUsage {
  usage: DreamUsageTotals | null;
  at: string | null;
}

export interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: Array<{ timestamp: string; log: string }>;
  createdAt: string;
  status: string;
  batchId?: string;
  // Sub-kind fields — at most one is set per update
  lintFix?: "stubs" | "orphans" | "merge" | "delete" | "rename";
  compactionType?: "scheduled" | "size";
  schemaEvolution?: {
    rationale: Array<{ change: string; evidence: string }>;
    confidence: "high" | "medium" | "low";
  };
  querybackSource?: {
    question: string;
    themesConsulted: string[];
  };
  aigisRollup?: {
    periodStart: string;
    periodEnd: string;
    cadence: "weekly" | "monthly";
  };
}

/** Outcome of submitting an approved `aigisRollup` pending to Aigis — see
 *  `POST /api/approve-update`'s `aigisSubmission` field and
 *  `packages/ui/src/lib/aigis-submit.ts`. */
export interface AigisSubmissionOutcome {
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

// Detect Tauri runtime — exported for use by logger.ts
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Dev API server base URL
const API_BASE = "http://localhost:3001/api";

// The dev-server's bearer guard is on by default (see server.ts) — vite.config.ts
// reads the same auto-generated token file and exposes it here so the browser can
// authenticate. Empty when this bundle wasn't built by our vite config (e.g. a
// stray import in a non-vite test context).
const DEV_TOKEN = (import.meta.env.VITE_OPENPULSE_TOKEN as string | undefined) ?? "";

// --- Transport layer ---
//
// Everything — Tauri or browser — talks to the SAME local Express server
// (`packages/ui/server.ts`) over plain `fetch` now. There used to be a
// per-command fork here (`isTauri ? tauriInvoke(...) : fetch(...)`) backed
// by ~15 Tauri commands in `src-tauri/src/*.rs`; those commands are gone
// (see `.superpowers/sdd/task-20-brief.md` — the server owns all vault/
// skills/dream logic, and the Rust side is now just a supervisor that keeps
// the server sidecar alive, see `src-tauri/src/server_sidecar.rs`). Several
// of those old Tauri branches called commands (`append_log`, `get_logs`)
// that were never even registered in `main.rs` — they would have thrown the
// moment anyone hit them in a packaged build.
//
// The remaining difference between the two runtimes is just how the base
// URL + auth token are discovered:
//   - Browser/dev: fixed `http://localhost:3001/api` + the vite-injected
//     token (unchanged from before).
//   - Tauri: the server binds an OS-assigned port (see `server.ts`'s
//     `listenWithFallback`) and generates its own token file — the ONE
//     remaining Tauri command, `get_server_info`, hands both to the webview
//     on first use. The result is cached for the lifetime of the page.

interface ResolvedApiBase {
  base: string;
  headers: Record<string, string>;
}

/**
 * Builds the (memoizing) base-URL/auth resolver. Exported so tests can drive
 * it with a fake `invokeFn` and a fake `tauri` flag without needing a real
 * Tauri webview or `window.__TAURI_INTERNALS__` — the module-level
 * `resolveApiBase` below is just this, wired to the real `isTauri`/`invoke`.
 *
 * Never caches a *failed* lookup: `get_server_info` can legitimately fail
 * once (e.g. called before the Rust supervisor has parsed the server's
 * readiness line yet) and should be retried on the next call rather than
 * wedging every subsequent API call for the rest of the page's lifetime.
 */
export function createApiBaseResolver(
  tauri: boolean,
  invokeFn: () => Promise<{ port: number; token: string }>,
  fallback: ResolvedApiBase,
): () => Promise<ResolvedApiBase> {
  let inFlight: Promise<ResolvedApiBase> | null = null;

  return function resolveApiBase(): Promise<ResolvedApiBase> {
    if (!tauri) return Promise.resolve(fallback);
    if (inFlight) return inFlight;

    const promise: Promise<ResolvedApiBase> = invokeFn()
      .then((info) => {
        const headers: Record<string, string> = info.token ? { Authorization: `Bearer ${info.token}` } : {};
        return { base: `http://127.0.0.1:${info.port}/api`, headers };
      })
      .catch((err) => {
        inFlight = null; // don't wedge on a transient failure — allow a retry
        throw err;
      });
    inFlight = promise;
    return promise;
  };
}

const DEV_HEADERS: Record<string, string> = DEV_TOKEN ? { Authorization: `Bearer ${DEV_TOKEN}` } : {};

const resolveApiBase = createApiBaseResolver(
  isTauri,
  () => invoke<{ port: number; token: string }>("get_server_info"),
  { base: API_BASE, headers: DEV_HEADERS },
);

/** Auth header for /api calls. Exported so call sites that can't go through
 *  apiGet/apiPost (e.g. a raw fetch for a non-JSON response) still attach it. */
export async function authHeaders(): Promise<Record<string, string>> {
  return (await resolveApiBase()).headers;
}

/** Base URL for `/api/*` requests — `http://localhost:3001/api` in the
 *  browser/dev, `http://127.0.0.1:<port>/api` in Tauri (port learned from
 *  `get_server_info`, see `createApiBaseResolver` above). */
export async function apiBaseUrl(): Promise<string> {
  return (await resolveApiBase()).base;
}

export async function apiGet<T>(path: string): Promise<T> {
  const { base, headers } = await resolveApiBase();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/**
 * Thrown by `apiPost`/`apiGet` on a non-2xx response. Carries the HTTP status
 * and the parsed JSON body (when the server sent one) so callers can react
 * to specific error shapes — e.g. the approve endpoint's `409 { error:
 * "stale", theme, reason }` — instead of only seeing a generic message.
 */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const bodyMessage = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : undefined;
    super(bodyMessage ?? `API error: ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { base, headers } = await resolveApiBase();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
  return res.json();
}

// --- Public API ---

export async function getVaultHealth(): Promise<VaultHealth> {
  return apiGet("/vault-health");
}

/** Latest Dream Pipeline run's token/call/retry totals, for the Dashboard. */
export async function getDreamUsage(): Promise<DreamUsage> {
  return apiGet("/dream-usage");
}

export async function listPendingUpdates(): Promise<PendingUpdate[]> {
  return apiGet("/pending-updates");
}

/** Approves a pending update. Returns the Aigis submission outcome when the
 *  approved update was an `aigisRollup` pending (see `POST /api/approve-update`'s
 *  `aigisSubmission` field) — undefined for every other update kind. */
export async function approveUpdate(id: string, editedContent?: string): Promise<{ aigisSubmission?: AigisSubmissionOutcome }> {
  const result = await apiPost<{ ok: boolean; aigisSubmission?: AigisSubmissionOutcome }>("/approve-update", { id, editedContent: editedContent ?? null });
  return { aigisSubmission: result.aigisSubmission };
}

export interface BatchApproveResult {
  id: string;
  ok: boolean;
  stale?: boolean;
  aigisSubmission?: AigisSubmissionOutcome;
}

/** Retries a previously failed/skipped Aigis submission for an already-
 *  approved `aigisRollup` update (see `POST /api/aigis-resubmit/:updateId`). */
export async function resubmitAigisRollup(updateId: string): Promise<void> {
  await apiPost(`/aigis-resubmit/${encodeURIComponent(updateId)}`, {});
}

export interface AigisLastSubmission {
  found: boolean;
  updateId?: string;
  theme?: string;
  submittedAt?: string;
  ok?: boolean;
  error?: string;
  /** True when the last attempt was skipped (Aigis not connected) rather
   *  than a real submission failure — see aigis-submit.ts's AigisSubmissionRecord. */
  skipped?: boolean;
}

/** Last recorded Aigis submission outcome (any update) — backs the Settings
 *  "Connect Aigis" card's status line. */
export async function getAigisLastSubmission(): Promise<AigisLastSubmission> {
  return apiGet("/aigis-last-submission");
}

/**
 * Approves a whole "Approve All" batch as one server-side action so it lands
 * as a single vault-git commit listing every theme (see
 * `.superpowers/sdd/task-5-brief.md` §B and `POST /api/approve-batch`) rather
 * than one commit per item.
 */
export async function approveUpdatesBatch(ids: string[]): Promise<BatchApproveResult[]> {
  return apiPost("/approve-batch", { ids });
}

export async function rejectUpdate(id: string): Promise<void> {
  await apiPost("/reject-update", { id });
}

/**
 * Regenerates a stale pending update against the current on-disk page (see
 * `POST /api/pending/:id/regenerate`).
 */
export async function regeneratePendingUpdate(id: string): Promise<PendingUpdate> {
  const result = await apiPost<{ ok: boolean; update: PendingUpdate }>(`/pending/${encodeURIComponent(id)}/regenerate`, {});
  return result.update;
}

export async function triggerDream(): Promise<string> {
  const result = await apiPost<{ output: string }>("/trigger-dream", {});
  return result.output;
}

export async function getLlmConfig(): Promise<{ provider: string; model: string; apiKey?: string; hasKey?: boolean; keyHint?: string; baseUrl?: string }> {
  return apiGet("/llm-config");
}

export async function saveLlmSettings(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<void> {
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
  return apiPost("/validate-models", { provider, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}

export interface TestModelResult {
  success: boolean;
  response?: string;
  error?: string;
}

export async function testModel(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<TestModelResult> {
  return apiPost("/test-model", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}

export interface AigisConfigInfo {
  endpoint: string;
  submitTool: string;
  /** Effective enabled state — already gated on endpointValid by the server (readAigisConfigForApi). */
  enabled: boolean;
  /** Whether `endpoint` is a valid https URL. When false, `enabled` is forced false regardless of the saved flag. */
  endpointValid: boolean;
  hasToken: boolean;
  tokenHint?: string;
}

export interface AigisTestResult {
  ok: boolean;
  tools: string[];
  hasSubmitTool: boolean;
  error?: string;
}

export async function getAigisConfig(): Promise<AigisConfigInfo> {
  return apiGet("/aigis-config");
}

export async function saveAigisConfig(endpoint: string, authToken: string | undefined, submitTool: string, enabled: boolean): Promise<void> {
  await apiPost("/aigis-config", { endpoint, authToken: authToken ?? null, submitTool, enabled });
}

export async function testAigisConnection(endpoint?: string, authToken?: string, submitTool?: string): Promise<AigisTestResult> {
  return apiPost("/aigis-test", { endpoint: endpoint ?? null, authToken: authToken ?? null, submitTool: submitTool ?? null });
}

export async function getVaultPath(): Promise<string> {
  const result = await apiGet<{ path: string }>("/vault-path");
  return result.path;
}

export async function getProjectPath(): Promise<string> {
  const result = await apiGet<{ path: string }>("/project-path");
  return result.path;
}

export interface ClaudeDesktopStatus {
  installed: boolean;
  connected: boolean;
  configPath: string;
}

export async function getClaudeDesktopStatus(): Promise<ClaudeDesktopStatus> {
  return apiGet("/claude-desktop-status");
}

export async function connectClaudeDesktop(): Promise<void> {
  await apiPost("/claude-desktop-connect", {});
}

export async function disconnectClaudeDesktop(): Promise<void> {
  await apiPost("/claude-desktop-disconnect", {});
}

export interface HotEntry {
  id: string;
  timestamp: string;
  log: string;
  theme?: string;
  source?: string;
}

export async function deleteHotEntry(id: string): Promise<void> {
  const { base, headers } = await resolveApiBase();
  const res = await fetch(`${base}/hot-entries/${encodeURIComponent(id)}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export type ProjectStatus = "active" | "paused" | "blocked" | "complete" | "dormant";

export interface WarmTheme {
  theme: string;
  content: string;
  lastUpdated: string;
  type?: string;
  skills?: string[];
  status?: ProjectStatus;
  statusReason?: string;
}

export async function getHotEntries(): Promise<HotEntry[]> {
  return apiGet("/hot-entries");
}

export async function getWarmThemes(): Promise<WarmTheme[]> {
  return apiGet("/warm-themes");
}

export interface ThemeSearchResult {
  theme: string;
  heading: string;
  snippet: string;
  score: number;
  rank: number;
}

/** Result of the Themes page's search box — `embeddings: false` means the
 *  local hybrid index is running keyword (FTS)-only in this process, e.g. a
 *  packaged/SEA build (see `core`'s `isEmbeddingsAvailable` and
 *  `GET /api/search`'s response shape). */
export interface ThemeSearchResponse {
  results: ThemeSearchResult[];
  embeddings: boolean;
}

/** Backs the Themes page's search box — ranked snippet search over the
 *  local hybrid index (`GET /api/search`). */
export async function searchThemes(query: string): Promise<ThemeSearchResponse> {
  return apiGet(`/search?q=${encodeURIComponent(query)}`);
}

export async function getBacklinks(): Promise<Record<string, string[]>> {
  return apiGet("/backlinks");
}

export interface SkillData {
  name: string;
  description: string;
  schedule: string | null;
  lookback: string;
  requires: { bins: string[]; env: string[] };
  body: string;
  setupGuide: string;
  config: Array<{ key: string; label: string; default?: string; type?: string }>;
  eligible: boolean;
  missing: string[];
  lastRunAt: string | null;
  lastStatus: string;
  entriesCollected: number;
  lastError?: string;
  isBuiltin: boolean;
}

export async function getSkills(): Promise<SkillData[]> {
  return apiGet("/skills");
}

export async function getSkillConfig(name: string): Promise<Record<string, string>> {
  return apiGet(`/skill-config/${name}`);
}

export async function saveSkillConfig(name: string, config: Record<string, string>): Promise<void> {
  await apiPost(`/skill-config/${name}`, config);
}

export async function fetchConfluenceSpaces(
  domain: string,
  email: string,
  token: string
): Promise<Array<{ key: string; name: string }>> {
  return apiPost("/confluence-activity/spaces", { domain, email, token });
}

export interface GithubRepoInfo {
  name: string;
  description: string;
  visibility: string;
}

export async function checkGithubRepo(url: string): Promise<GithubRepoInfo> {
  return apiPost("/github-activity/check-repo", { url });
}

export interface ObsidianVault {
  name: string;
  path: string;
}

export async function fetchObsidianVaults(): Promise<{ vaults: ObsidianVault[]; error?: string }> {
  return apiGet("/obsidian-notes/vaults");
}

export interface ChatResponse {
  content: string;
  sessionId: string;
  model: string;
  tokensUsed: number;
  contextWindow: number;
}

export async function chatSendMessage(
  message: string,
  sessionId?: string,
  model?: string,
): Promise<ChatResponse> {
  return apiPost("/chat", { message, sessionId, model });
}

export interface ChatModelOptions {
  provider: string;
  defaultModel: string;
  models: string[];
  passthrough: boolean;
}

export async function fetchChatModels(): Promise<ChatModelOptions> {
  return apiGet("/chat/models");
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

export interface ChatSessionFull {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  themesConsulted: string[];
  createdAt: string;
  lastActivity: string;
  /** Per-session model override (set when the user picks one in the dropdown). */
  model?: string;
}

export async function listChatSessions(): Promise<ChatSessionMeta[]> {
  const r = await apiGet<{ sessions: ChatSessionMeta[] }>("/chat/sessions");
  return r.sessions;
}

export interface ChatSessionLoadResult {
  session: ChatSessionFull;
  tokensUsed: number;
  contextWindow: number;
}

export async function getChatSession(id: string): Promise<ChatSessionLoadResult> {
  return apiGet(`/chat/sessions/${encodeURIComponent(id)}`);
}

export async function deleteChatSession(id: string): Promise<void> {
  const { base, headers } = await resolveApiBase();
  const res = await fetch(`${base}/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function installDependency(dep: string): Promise<{ success: boolean; output: string }> {
  return apiPost("/install-dependency", { dep });
}

export async function installSkill(repo: string): Promise<string> {
  const result = await apiPost<{ output: string }>("/skills/install", { repo });
  return result.output;
}

export async function removeSkill(name: string): Promise<void> {
  const { base, headers } = await resolveApiBase();
  const res = await fetch(`${base}/skills/${name}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function runSkillNow(name: string): Promise<string> {
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

export interface OrchestratorLintPipeline {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: { time: string; days: string[] };
}

export interface OrchestratorCompactionPipeline {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: { time: string; days: string[] };
  perThemeLastCompacted: Record<string, string>;
  sizeQueue: string[];
}

export interface OrchestratorSchemaEvolutionPipeline {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: { time: string; days: string[] };
}

export interface OrchestratorAigisRollupPipeline {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: { time: string; days: string[] };
  cadence: "weekly" | "monthly";
}

export interface OrchestratorStatus {
  running: boolean;
  lastHeartbeat: string;
  collectors: Record<string, OrchestratorCollector>;
  dreamPipeline: OrchestratorDreamPipeline;
  lintPipeline?: OrchestratorLintPipeline;
  compactionPipeline?: OrchestratorCompactionPipeline;
  schemaEvolutionPipeline?: OrchestratorSchemaEvolutionPipeline;
  aigisRollupPipeline?: OrchestratorAigisRollupPipeline;
}

export async function getOrchestratorStatus(): Promise<OrchestratorStatus> {
  return apiGet("/orchestrator-status");
}

export async function updateSchedule(skill: string, schedules: OrchestratorSchedule[], enabled: boolean): Promise<void> {
  await apiPost("/orchestrator-schedule", { skill, schedules, enabled });
}

export async function triggerOrchestratorRun(target: string): Promise<string> {
  const result = await apiPost<{ output: string }>("/orchestrator-run", { target });
  return result.output;
}

export async function toggleOrchestratorSchedule(target: string, enabled: boolean): Promise<void> {
  await apiPost("/orchestrator-toggle", { target, enabled });
}
