/**
 * Dev API server — bridges the UI to the real vault filesystem.
 * Replaces mock data in development (no Tauri needed).
 *
 * Also the always-on Tauri sidecar entry point (bundled by
 * scripts/build-sidecar-ui.sh into src-tauri/sidecars/). Both flows share
 * `startServer()`; the difference is only how its options are sourced:
 *
 *   - Dev:     `npx tsx server.ts` — no args, defaults exactly as before
 *              (port 3001, OPENPULSE_VAULT/~/OpenPulseAI, orchestrator
 *              started, VITEST guard on the search-index warm-up).
 *   - Sidecar: bundled binary launched by the Rust supervisor (a later
 *              task), reading OPENPULSE_PORT / OPENPULSE_VAULT / --port.
 *
 * Run: npx tsx server.ts
 */
import express from "express";
import cors from "cors";
import { readdir, readFile, writeFile, rm, stat, mkdir, appendFile, rename, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { Orchestrator, type OrchestratorCallbacks } from "../core/dist/index.js";
import { discoverSkills, checkEligibility, loadCollectorState as loadSkillState } from "../core/dist/skills/index.js";
import { runSkillByName } from "../core/dist/skills/run.js";
import { Vault, readAllThemes, parseActivityBlocks, splitHotFileBlocks, joinHotFileBlocks, loadConfig, rebuildIndex, searchWithRebuildRetry, testAigisConnection, DEFAULT_AIGIS_SUBMIT_TOOL, isValidAigisEndpoint, type AigisConfig } from "../core/dist/index.js";
import { isDreamLockHeld } from "../dream/dist/lock.js";
import { approvePendingUpdate, approvePendingUpdatesBatch, regeneratePendingUpdate } from "./src/lib/approve.js";
import { resubmitAigisRollup } from "./src/lib/aigis-submit.js";
import { loadOrCreateToken, tokenPath, isAuthorizedHeader } from "./dev-token.js";

const execFileAsync = promisify(execFile);

const SAFE_NAME = /^[\w-]+$/;

/** Mask a secret for display — never expose the full value to a client. */
function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const k = key.trim();
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  ollama: "",
};

const CHAT_MODEL_ALLOWLIST: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
  ],
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite-preview",
  ],
  mistral: [
    "mistral-large-latest",
    "mistral-small-latest",
  ],
  // ollama: passthrough (local models with arbitrary user-defined names)
};

/**
 * Approximate context-window sizes per model. Used only for the chat page's
 * "context % used" indicator — a rough hint for the user, not for routing.
 *
 * Keep in sync with CHAT_MODEL_ALLOWLIST as new models are added. For unknown
 * models (e.g. Ollama local builds) we fall back to a conservative default.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-7": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  // Gemini
  "gemini-2.5-pro": 2_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-3.1-flash-lite-preview": 1_000_000,
  // Mistral
  "mistral-large-latest": 128_000,
  "mistral-small-latest": 32_000,
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

export function lookupContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimate token usage for a session. ~4 chars per token is a rough rule for
 * English; we add a constant overhead for the system prompt + injected theme
 * context. Intentionally approximate — the indicator is a "you're getting full"
 * cue, not a meter the user should trust to the last 10%.
 */
export function estimateTokensUsed(messages: Array<{ content: string }>, systemOverheadTokens = 1000): number {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(totalChars / 4) + systemOverheadTokens;
}

/** Validate a user-supplied model string against the allowlist for the configured provider. */
export function isAllowedChatModel(provider: string, model: string): boolean {
  if (provider === "ollama") {
    // Local models — accept anything that looks like a sensible identifier.
    return /^[\w./:-]{1,80}$/.test(model);
  }
  return CHAT_MODEL_ALLOWLIST[provider]?.includes(model) ?? false;
}

export interface ChatSessionFile {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  themesConsulted: string[];
  createdAt: string;
  lastActivity: string;
  pendingFile?: unknown;
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

/**
 * Build a sidebar-friendly summary of a session: a title (first user message,
 * truncated to 60 chars; "New chat" if no user messages yet) + counts/timestamps.
 * Pure function — exported so tests can exercise the title heuristic without
 * spinning up an express app.
 */
export function summariseSession(s: ChatSessionFile): ChatSessionMeta {
  const firstUser = s.messages.find((m) => m.role === "user")?.content?.trim() ?? "";
  let title = firstUser ? firstUser.replace(/\s+/g, " ") : "New chat";
  if (title.length > 60) title = title.slice(0, 57).trimEnd() + "…";
  return {
    id: s.id,
    title,
    createdAt: s.createdAt,
    lastActivity: s.lastActivity,
    messageCount: s.messages.length,
  };
}

interface AigisConfigApiShape {
  endpoint: string;
  submitTool: string;
  enabled: boolean;
  /** Whether `endpoint` passes the same https-URL gate the runtime uses (parseAigisConfig in core/config.ts). */
  endpointValid: boolean;
  hasToken: boolean;
  tokenHint?: string;
}

/**
 * Reads config.yaml's aigis section for the Settings UI. Never returns the raw
 * token — hasToken + a masked hint only, mirroring the llm-config idiom above.
 *
 * `enabled` here is the *effective* enabled state — it runs the same
 * isValidAigisEndpoint gate the runtime (parseAigisConfig) uses, so a
 * hand-edited config.yaml with `enabled: true` but a bad/non-https endpoint
 * reports as disabled here too, matching what actually happens at runtime.
 * `endpointValid` is surfaced separately so the UI can explain *why*.
 */
export async function readAigisConfigForApi(vaultRoot: string): Promise<AigisConfigApiShape> {
  const configPath = join(vaultRoot, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = (loadYaml(raw) as any) ?? {};
    const aigis = parsed.aigis ?? {};
    const token: string | undefined = aigis.authToken;
    const endpoint: string = aigis.endpoint ?? "";
    const endpointValid = isValidAigisEndpoint(endpoint);
    return {
      endpoint,
      submitTool: aigis.submitTool ?? DEFAULT_AIGIS_SUBMIT_TOOL,
      enabled: Boolean(aigis.enabled) && endpointValid,
      endpointValid,
      hasToken: Boolean(token),
      tokenHint: maskKey(token),
    };
  } catch {
    return { endpoint: "", submitTool: DEFAULT_AIGIS_SUBMIT_TOOL, enabled: false, endpointValid: false, hasToken: false };
  }
}

/** Thrown by saveAigisConfigForApi when asked to enable with an endpoint that will never pass the runtime gate. */
export class InvalidAigisEndpointError extends Error {
  constructor() {
    super("Aigis endpoint must be a valid https URL to enable the connection");
    this.name = "InvalidAigisEndpointError";
  }
}

/**
 * Saves config.yaml's aigis section. A blank authToken means "keep the
 * existing one" (same convention as save-llm-settings' apiKey handling) —
 * only an explicitly-typed new token overwrites it. Reads and rewrites the
 * whole document via js-yaml so other top-level sections (themes, llm) are
 * preserved rather than clobbered.
 *
 * Refuses (throws InvalidAigisEndpointError) to persist enabled:true paired
 * with an endpoint that fails isValidAigisEndpoint — the same https-URL gate
 * the runtime (parseAigisConfig in core/config.ts) enforces. Without this,
 * a bad endpoint could be saved as "enabled" and the Settings/Schedule UI
 * would show it active while every outbound call silently no-op'd.
 */
export async function saveAigisConfigForApi(
  vaultRoot: string,
  body: { endpoint?: string; authToken?: string; submitTool?: string; enabled?: boolean }
): Promise<void> {
  if (body.enabled && !isValidAigisEndpoint(body.endpoint)) {
    throw new InvalidAigisEndpointError();
  }

  const configPath = join(vaultRoot, "config.yaml");
  await mkdir(vaultRoot, { recursive: true });

  let parsed: any = {};
  try {
    parsed = (loadYaml(await readFile(configPath, "utf-8")) as any) ?? {};
  } catch { /* no existing config */ }

  const existingToken: string | undefined = parsed?.aigis?.authToken;
  const effectiveToken = body.authToken || existingToken;

  parsed.aigis = {
    endpoint: body.endpoint ?? "",
    submitTool: body.submitTool || DEFAULT_AIGIS_SUBMIT_TOOL,
    enabled: Boolean(body.enabled),
    ...(effectiveToken ? { authToken: effectiveToken } : {}),
  };

  await writeFile(configPath, dumpYaml(parsed), "utf-8");
}

/**
 * Reads the last recorded Aigis submission outcome (any update) straight off
 * disk — a plain read, no `Vault.init()` (fix round 1 #5): `init()` mkdir's
 * every vault subdirectory and adopts/creates a git repo, all of which is
 * unnecessary side effect for what's meant to be a read-only status check,
 * and would even create vault directories on a machine that has none yet
 * just from loading the Settings page. Missing file/dir is treated the same
 * as "no submissions yet" rather than an error.
 */
export async function readAigisLastSubmissionForApi(vaultRoot: string): Promise<Record<string, unknown>> {
  const path = join(vaultRoot, "vault", "aigis", "submissions.jsonl");
  const raw = await readFile(path, "utf-8").catch(() => "");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return { found: false };
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return { found: true, ...last };
  } catch {
    return { found: false };
  }
}

/**
 * Ranked snippet search over the local hybrid index (see @openpulse/core's
 * search module) — extracted from the route handler so it's directly
 * unit-testable against a temp vault (same pattern as approve.ts). An
 * empty/blank query short-circuits to no results. Empty index → one
 * rebuild + retry (same pattern as the MCP search_index tool).
 */
export async function searchThemesForApi(vaultRoot: string, q: string) {
  if (!q.trim()) return [];
  const vault = new Vault(vaultRoot);
  await vault.init();
  return searchWithRebuildRetry(vault, q);
}

/**
 * Detect whether a config change adds new collection scope (e.g., new repo URLs,
 * new space keys, new vault paths). When it does, the next collector run should
 * backfill the new entries — but the runner's lookback only kicks in when
 * lastRunAt is null. So we reset lastRunAt on scope-adding changes.
 *
 * Heuristic: a field is multi-value if either old or new contains a comma or
 * newline. For multi-value fields, check whether next has any entries that prev
 * didn't. Single-value fields (token, domain, single ID) never trigger a reset
 * — auth changes shouldn't replay a week of history.
 */
export function configAddsNewScope(
  prev: Record<string, string>,
  next: Record<string, string>
): boolean {
  const SEPS = /[\n,]/;
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    const prevVal = prev[key] ?? "";
    const nextVal = next[key] ?? "";
    if (prevVal === nextVal) continue;
    if (!SEPS.test(prevVal) && !SEPS.test(nextVal)) continue; // single-value field
    const prevSet = new Set(prevVal.split(SEPS).map((s) => s.trim()).filter(Boolean));
    const nextSet = new Set(nextVal.split(SEPS).map((s) => s.trim()).filter(Boolean));
    for (const item of nextSet) if (!prevSet.has(item)) return true;
  }
  return false;
}

/** Options accepted by startServer() — the bootstrap contract shared by the
 *  dev flow (`npx tsx server.ts`, no opts) and the bundled Tauri sidecar
 *  (opts sourced from env/args by the CLI entry at the bottom of this file). */
export interface StartServerOptions {
  /** Listen port. Falls back to OPENPULSE_PORT env, then 3001. On EADDRINUSE
   *  the next 10 ports are tried in turn (see listenWithFallback below) —
   *  the actual bound port is always reported via ServerHandle.port and the
   *  `OPENPULSE_SERVER_READY` stdout line. */
  port?: number;
  /** Bind host. Falls back to OPENPULSE_HOST env, then 127.0.0.1. */
  host?: string;
  /** Vault/config root. Falls back to OPENPULSE_VAULT env, then ~/OpenPulseAI. */
  vaultRoot?: string;
  /** Explicit ui-token file path override (tests only — normal runs derive
   *  it from vaultRoot via dev-token.ts's tokenPath()). */
  tokenPath?: string;
}

/** Handle returned by startServer() — lets tests (and the CLI shutdown
 *  handlers) drive the server without relying on process-level signals. */
export interface ServerHandle {
  app: express.Express;
  server: Server;
  port: number;
  vaultRoot: string;
  /** Stops the orchestrator, closes the HTTP server, and removes the
   *  discovery file. Idempotent — safe to call more than once. */
  close: () => Promise<void>;
}

/** Bind `app` to `port` on `host`, resolving once truly listening (rejects
 *  with the raw error — including EADDRINUSE — otherwise). */
function listenOnPort(app: express.Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

/** Try `startPort`, then the next `maxAttempts - 1` ports on EADDRINUSE —
 *  the sidecar context can't guarantee 3001 is free, and crashing would
 *  leave the webview with nothing to fetch. Any other listen error (e.g.
 *  EACCES) propagates immediately. */
async function listenWithFallback(app: express.Express, host: string, startPort: number, maxAttempts = 11): Promise<Server> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      return await listenOnPort(app, host, port);
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
      lastErr = err;
      console.warn(`[openpulse-ui] Port ${port} in use, trying ${port + 1}...`);
    }
  }
  throw lastErr;
}

/** Fallback discovery file for the webview when it can't otherwise learn the
 *  bound port (see StartServerOptions.port doc). Written atomically
 *  (temp file + rename) and mode 0600 — same posture as ui-token. Removed on
 *  clean shutdown. */
async function writeDiscoveryFile(vaultRoot: string, port: number): Promise<string> {
  const path = join(vaultRoot, "ui-server.json");
  const tmp = `${path}.${process.pid}.tmp`;
  const payload = JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + "\n";
  await mkdir(vaultRoot, { recursive: true });
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  return path;
}

/**
 * Starts the API server + orchestrator. Both the dev flow (`npx tsx
 * server.ts`, no opts — same defaults as before this refactor) and the
 * bundled Tauri sidecar (opts sourced from env/args, see the CLI entry at
 * the bottom of this file) go through this single function.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
const VAULT_ROOT = opts.vaultRoot ?? process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
// Bind to loopback by default so the server is never exposed on an external
// interface by accident. Set OPENPULSE_HOST=0.0.0.0 only behind a reverse proxy.
const HOST = opts.host ?? process.env.OPENPULSE_HOST ?? "127.0.0.1";
const REQUESTED_PORT = opts.port ?? (process.env.OPENPULSE_PORT ? Number(process.env.OPENPULSE_PORT) : 3001);
// The bearer guard is ALWAYS on — this API can run skills, install deps, and
// write Claude Desktop config, so there's no safe "open" posture even on
// loopback (any local process/browser tab could otherwise hit it). An explicit
// OPENPULSE_API_TOKEN env var wins (e.g. a shared/production deployment);
// otherwise a persistent token is auto-generated and stored in the config dir
// (~/OpenPulseAI/ui-token, mode 0600) the first time the server starts, and
// reused on every subsequent start. vite.config.ts reads the same file so the
// browser bundle can authenticate — see VITE_OPENPULSE_TOKEN there.
const API_TOKEN = process.env.OPENPULSE_API_TOKEN || (await loadOrCreateToken(VAULT_ROOT, opts.tokenPath));

/** Read the stored LLM apiKey from config.yaml. Server-side only — never returned to clients. */
async function readStoredApiKey(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(VAULT_ROOT, "config.yaml"), "utf-8");
    return raw.match(/apiKey:\s*(.+)/)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const app = express();
// Restrict CORS to localhost origins — this is a local dev server with vault access.
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no Origin header) and any localhost port.
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json());

// Auth guard — always on (see API_TOKEN above for how the token is sourced).
// This API can run skills, install deps, and write Claude Desktop config, so
// there's no endpoint exempted from it: the browser bundle gets the token at
// build time via vite.config.ts, so there's no unauthenticated bootstrap step
// that legitimately needs an exemption.
app.use("/api", (req, res, next) => {
  if (isAuthorizedHeader(req.header("authorization"), API_TOKEN)) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// --- Helpers ---

const vaultDir = join(VAULT_ROOT, "vault");
const hotDir = join(vaultDir, "hot");
const warmDir = join(vaultDir, "warm");
const pendingDir = join(warmDir, "_pending");
const coldDir = join(vaultDir, "cold");

async function countFiles(dir: string, ext: string): Promise<number> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// --- Routes ---

app.get("/api/vault-health", async (_req, res) => {
  const vaultExists = await dirExists(vaultDir);

  // Count actual hot entries (blocks in daily files + ingested docs)
  let hotCount = 0;
  try {
    const files = await readdir(hotDir);
    for (const file of files) {
      if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
      const content = await readFile(join(hotDir, file), "utf-8");
      hotCount += splitHotFileBlocks(content).filter((b) => b.trim()).length;
    }
    // Count ingested documents
    try {
      const ingestFiles = await readdir(join(hotDir, "ingest"));
      hotCount += ingestFiles.filter((f) => f.endsWith(".md")).length;
    } catch { /* ingest dir may not exist */ }
  } catch { /* hot dir may not exist */ }

  // Exclude system files from warm theme count
  const warmFiles = (await readdir(warmDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".md") && !f.startsWith("_") && f !== "index.md" && f !== "log.md"
  );
  const warmCount = warmFiles.length;
  const pendingCount = await countFiles(pendingDir, ".json");
  res.json({ hotCount, warmCount, pendingCount, vaultExists });
});

app.get("/api/pending-updates", async (_req, res) => {
  try {
    const files = await readdir(pendingDir);
    const updates = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(pendingDir, file), "utf-8");
        const update = JSON.parse(content);
        if (update.status === "pending") updates.push(update);
      } catch (e) {
        console.error("[server] Failed to parse pending update:", file, e);
      }
    }
    updates.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
    res.json(updates);
  } catch {
    res.json([]);
  }
});

app.post("/api/approve-update", async (req, res) => {
  const { id, editedContent } = req.body;
  if (!id || !/^[\w-]+$/.test(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const outcome = await approvePendingUpdate(VAULT_ROOT, pendingDir, id, editedContent ?? undefined);

    if (!outcome.ok) {
      return res.status(outcome.status).json({
        ok: false,
        error: outcome.error,
        ...(outcome.stale ? { stale: true, theme: outcome.theme, reason: outcome.reason } : {}),
      });
    }

    // Size check for dream-pipeline project updates: enqueue compaction if
    // > 14 dated sections (### YYYY-MM-DD). Only for untagged dream updates.
    const update = outcome.update;
    if (!update.lintFix && !update.compactionType && !update.schemaEvolution && !update.querybackSource && !update.aigisRollup) {
      const sectionCount = (outcome.finalContent.match(/^###\s+\d{4}-\d{2}-\d{2}\b/gm) ?? []).length;
      if (sectionCount > 14 && update.type === "project") {
        await orchestrator.enqueueForCompaction([outcome.theme]);
        // Fire-and-forget immediate run for responsiveness
        orchestrator.triggerCompact([outcome.theme]).catch((err: unknown) => {
          console.error("[server] triggerCompact failed:", err instanceof Error ? err.message : String(err));
        });
      }
    }

    // Rebuild index.md and _backlinks.md in the background — fire and forget.
    // Skipped for aigisRollup: it never touches warm/index/backlinks (see
    // approve.ts), so there's nothing for rebuild-meta to do.
    if (!update.aigisRollup) {
      const rebuildBin = join(process.cwd(), "..", "dream", "dist", "rebuild-meta.js");
      execFile("node", [rebuildBin], { env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT } }, (err, _stdout, stderr) => {
        if (err) console.error("[server] rebuild-meta failed:", err.message, stderr || "");
      });
    }

    res.json({ ok: true, ...(outcome.aigisSubmission ? { aigisSubmission: outcome.aigisSubmission } : {}) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/approve-batch", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === "string" && /^[\w-]+$/.test(id))) {
    return res.status(400).json({ error: "Invalid ids" });
  }
  try {
    const results = await approvePendingUpdatesBatch(VAULT_ROOT, pendingDir, ids);

    // Mirror the single-approve side effects (oversized-page compaction
    // enqueue) for every item that actually wrote — see /api/approve-update.
    for (const { outcome } of results) {
      if (!outcome.ok) continue;
      const update = outcome.update;
      if (!update.lintFix && !update.compactionType && !update.schemaEvolution && !update.querybackSource && !update.aigisRollup) {
        const sectionCount = (outcome.finalContent.match(/^###\s+\d{4}-\d{2}-\d{2}\b/gm) ?? []).length;
        if (sectionCount > 14 && update.type === "project") {
          await orchestrator.enqueueForCompaction([outcome.theme]);
          orchestrator.triggerCompact([outcome.theme]).catch((err: unknown) => {
            console.error("[server] triggerCompact failed:", err instanceof Error ? err.message : String(err));
          });
        }
      }
    }

    // Rebuild index.md/_backlinks.md once for the whole batch, not per item
    // (an all-aigisRollup batch still triggers it — cheap no-op; see the
    // single-approve path for the per-item skip).
    if (results.some((r) => r.outcome.ok)) {
      const rebuildBin = join(process.cwd(), "..", "dream", "dist", "rebuild-meta.js");
      execFile("node", [rebuildBin], { env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT } }, (err, _stdout, stderr) => {
        if (err) console.error("[server] rebuild-meta failed:", err.message, stderr || "");
      });
    }

    res.json(
      results.map(({ id, outcome }) => ({
        id,
        ok: outcome.ok,
        ...(outcome.ok
          ? { ...(outcome.aigisSubmission ? { aigisSubmission: outcome.aigisSubmission } : {}) }
          : { error: outcome.error, ...(outcome.stale ? { stale: true, theme: outcome.theme, reason: outcome.reason } : {}) }),
      }))
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/pending/:id/regenerate", async (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const config = await loadConfig(VAULT_ROOT);
    const { createProvider } = await import("../core/dist/index.js");
    const provider = createProvider(config);
    const outcome = await regeneratePendingUpdate(VAULT_ROOT, pendingDir, id, provider, config.llm.model);
    if (!outcome.ok) {
      return res.status(outcome.status).json({ ok: false, error: outcome.error });
    }
    res.json({ ok: true, update: outcome.update });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/reject-update", async (req, res) => {
  const { id } = req.body;
  if (!id || !/^[\w-]+$/.test(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    await rm(join(pendingDir, `${id}.json`));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/trigger-dream", async (_req, res) => {
  try {
    const dreamBin = join(process.cwd(), "..", "dream", "dist", "index.js");
    const { stderr } = await execFileAsync("node", [dreamBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      // Match the orchestrator's dream-pipeline timeout (300s, see
      // orchestrator.ts) — a 60s timeout here made manual "trigger now" runs
      // far more likely to get killed mid-retry (LLM retries, slow local
      // Ollama models) than the orchestrator's own scheduled runs (M5).
      timeout: 300000,
    });
    res.json({ output: stderr || "Dream pipeline completed." });
  } catch (e: any) {
    const output = e.stderr || e.message;
    res.json({ output });
  }
});

app.post("/api/trigger-lint", async (_req, res) => {
  try {
    await orchestrator.triggerLint();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Chat (in-app, backed by handleChatWithPulse) ---

const CHAT_MESSAGE_MAX = 8000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-provider allowlist for the chat model selector. Curated to match the
 * BYOM picker on the Settings page. Ollama is local-first so we passthrough
 * any model name (after a basic safety check); for hosted providers we keep
 * the list tight to avoid surprise costs from typo'd model names.
 *
 * Order matters — first entry is shown as the default in the dropdown when
 * no per-session override is set.
 */

app.get("/api/chat/sessions", async (_req, res) => {
  try {
    const sessionsDir = join(VAULT_ROOT, "vault", "sessions");
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      // Directory doesn't exist yet — no sessions
      return res.json({ sessions: [] });
    }
    const summaries: ChatSessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(sessionsDir, f), "utf-8");
        const parsed = JSON.parse(raw) as ChatSessionFile;
        if (typeof parsed?.id !== "string") continue;
        summaries.push(summariseSession(parsed));
      } catch {
        // Skip malformed session files
      }
    }
    summaries.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    res.json({ sessions: summaries });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/sessions/:id", async (req, res) => {
  if (!SESSION_ID_RE.test(req.params.id)) {
    return res.status(400).json({ error: "invalid sessionId" });
  }
  try {
    const path = join(VAULT_ROOT, "vault", "sessions", `${req.params.id}.json`);
    const raw = await readFile(path, "utf-8");
    const session = JSON.parse(raw) as ChatSessionFile & { model?: string };
    // Compute context usage so the UI's indicator is accurate immediately on
    // session load (without the user having to send a message first).
    const config = await loadConfig(VAULT_ROOT);
    const effectiveModel = session.model ?? config.llm.model;
    const tokensUsed = estimateTokensUsed(session.messages);
    const contextWindow = lookupContextWindow(effectiveModel);
    res.json({ session, tokensUsed, contextWindow });
  } catch {
    res.status(404).json({ error: "session not found" });
  }
});

app.delete("/api/chat/sessions/:id", async (req, res) => {
  if (!SESSION_ID_RE.test(req.params.id)) {
    return res.status(400).json({ error: "invalid sessionId" });
  }
  try {
    const path = join(VAULT_ROOT, "vault", "sessions", `${req.params.id}.json`);
    await rm(path, { force: true });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/chat/models", async (_req, res) => {
  try {
    const config = await loadConfig(VAULT_ROOT);
    const provider = config.llm.provider;
    const allowed = CHAT_MODEL_ALLOWLIST[provider] ?? [];
    res.json({
      provider,
      defaultModel: config.llm.model,
      models: allowed,
      // For ollama, the UI should show the configured model only and let the user know
      // they can pick any local model name through Settings.
      passthrough: provider === "ollama",
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, model: requestedModel } = req.body as {
    message?: string;
    sessionId?: string;
    model?: string;
  };
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  if (message.length > CHAT_MESSAGE_MAX) {
    return res.status(400).json({ error: `message too long (max ${CHAT_MESSAGE_MAX} chars)` });
  }
  if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) {
    return res.status(400).json({ error: "invalid sessionId" });
  }
  try {
    const config = await loadConfig(VAULT_ROOT);
    if (requestedModel !== undefined && !isAllowedChatModel(config.llm.provider, requestedModel)) {
      return res.status(400).json({ error: `model "${requestedModel}" is not in the allowlist for provider ${config.llm.provider}` });
    }

    // Resolve the model with this priority:
    //   1. Explicit `model` in the request body (user just picked from dropdown)
    //   2. session.model (chosen earlier in this conversation)
    //   3. config.llm.model (global default)
    let model = requestedModel ?? config.llm.model;
    const sessionsDir = join(VAULT_ROOT, "vault", "sessions");
    if (sessionId && requestedModel === undefined) {
      try {
        const stored = JSON.parse(await readFile(join(sessionsDir, `${sessionId}.json`), "utf-8")) as ChatSessionFile & { model?: string };
        if (stored.model) model = stored.model;
      } catch { /* session doesn't exist yet — fall through to config default */ }
    }

    const { createProvider } = await import("../core/dist/index.js");
    const provider = createProvider(config);
    const vault = new Vault(VAULT_ROOT);
    await vault.init();
    const { handleChatWithPulse } = await import("../mcp-server/dist/tools/chat-with-pulse.js");
    const result = await handleChatWithPulse(vault, provider, model, { message, sessionId });

    // Strip the MCP-only "_[session: …]_" footer (already explained in the earlier comment).
    const text = result.content
      .map((c) => c.text)
      .join("\n")
      .replace(/\n*_\[session: [0-9a-f-]+\]_\s*$/i, "")
      .trim();

    // If the user explicitly chose a model on this turn, persist it onto the session
    // so subsequent turns default to the same model without needing to re-send it.
    let storedSession: (ChatSessionFile & { model?: string }) | null = null;
    try {
      const path = join(sessionsDir, `${result.sessionId}.json`);
      storedSession = JSON.parse(await readFile(path, "utf-8")) as ChatSessionFile & { model?: string };
      if (requestedModel !== undefined) {
        storedSession.model = requestedModel;
        await writeFile(path, JSON.stringify(storedSession, null, 2), "utf-8");
      }
    } catch { /* race or missing file — fine, no rollback needed */ }

    // Approximate context usage so the UI can show a "x% used" hint near the model dropdown.
    const tokensUsed = storedSession
      ? estimateTokensUsed(storedSession.messages)
      : estimateTokensUsed([{ content: message }, { content: text }]);
    const contextWindow = lookupContextWindow(model);

    res.json({
      content: text,
      sessionId: result.sessionId,
      model,
      tokensUsed,
      contextWindow,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/trigger-compact", async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.themes) ? req.body.themes : [];
    const themes = raw.filter((t: unknown) => typeof t === "string" && SAFE_NAME.test(t as string));
    await orchestrator.triggerCompact(themes.length > 0 ? themes : undefined);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/trigger-schema-evolve", async (_req, res) => {
  try {
    await orchestrator.triggerSchemaEvolve();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/trigger-aigis-rollup", async (_req, res) => {
  try {
    const outcome = await orchestrator.triggerAigisRollup();
    res.json({ ok: true, outcome });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/backlinks", async (_req, res) => {
  const backlinksPath = join(warmDir, "_backlinks.md");
  try {
    const raw = await readFile(backlinksPath, "utf-8");
    // Parse "## [[theme]]\n- [[source]]\n..." into Record<string, string[]>
    const result: Record<string, string[]> = {};
    const sections = raw.split(/\n## /);
    for (const section of sections.slice(1)) {
      const themeMatch = section.match(/^\[\[([^\]]+)\]\]/);
      if (!themeMatch) continue;
      const theme = themeMatch[1];
      const inbound = [...section.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map(m => m[1]);
      result[theme] = inbound;
    }
    res.json(result);
  } catch {
    res.json({});
  }
});

app.get("/api/lint-report", async (_req, res) => {
  const lintPath = join(VAULT_ROOT, "vault", "warm", "_lint.md");
  try {
    const content = await readFile(lintPath, "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: null });
  }
});

app.get("/api/llm-config", async (_req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const providerMatch = raw.match(/provider:\s*(\w+)/);
    const modelMatch = raw.match(/model:\s*(.+)/);
    const apiKeyMatch = raw.match(/apiKey:\s*(.+)/);
    const baseUrlMatch = raw.match(/baseUrl:\s*(.+)/);
    const storedKey = apiKeyMatch?.[1]?.trim();
    res.json({
      provider: providerMatch?.[1] ?? "anthropic",
      model: modelMatch?.[1]?.trim() ?? "claude-sonnet-4-5-20250929",
      // Never return the raw key. The UI only needs to know one exists and show a hint.
      hasKey: Boolean(storedKey),
      keyHint: maskKey(storedKey),
      baseUrl: baseUrlMatch?.[1]?.trim(),
    });
  } catch {
    res.json({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
  }
});

app.post("/api/save-llm-settings", async (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body;
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    // Ensure vault root exists
    await mkdir(VAULT_ROOT, { recursive: true });
    // Read existing config to preserve themes
    let themes: string[] = [];
    try {
      const raw = await readFile(configPath, "utf-8");
      const themesMatch = raw.match(/themes:\n((?:\s+-\s+.+\n)*)/);
      if (themesMatch) {
        themes = themesMatch[1].match(/-\s+(.+)/g)?.map((t) => t.replace(/^-\s+/, "")) ?? [];
      }
    } catch { /* no existing config */ }

    // The UI never receives the raw key, so a blank apiKey means "keep the existing
    // one" rather than "delete it". Only overwrite when the user typed a new key.
    const effectiveApiKey = apiKey || (await readStoredApiKey());

    let yaml = "";
    if (themes.length > 0) {
      yaml += `themes:\n${themes.map((t) => `  - ${t}`).join("\n")}\n`;
    }
    yaml += `llm:\n  provider: ${provider}\n  model: ${model}\n`;
    if (effectiveApiKey) {
      yaml += `  apiKey: ${effectiveApiKey}\n`;
    }
    if (baseUrl) {
      yaml += `  baseUrl: ${baseUrl}\n`;
    }

    await writeFile(configPath, yaml, "utf-8");

    // Set API key as env var hint (Stronghold when Tauri is available). Never log
    // key material — not even a prefix; prefixes still leak entropy and provider
    // key formats are fixed-width enough to narrow a brute-force search.
    if (apiKey) {
      console.log(`[server] API key for ${provider} received (hasKey: true). Set ${PROVIDER_ENV_KEYS[provider]} env var for the dream pipeline.`);
    }

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Aigis (aigis.bio outbound MCP connection) ---


app.get("/api/aigis-config", async (_req, res) => {
  res.json(await readAigisConfigForApi(VAULT_ROOT));
});

app.post("/api/aigis-config", async (req, res) => {
  try {
    await saveAigisConfigForApi(VAULT_ROOT, req.body ?? {});
    res.json({ ok: true });
  } catch (e: any) {
    if (e instanceof InvalidAigisEndpointError) {
      return res.status(400).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/aigis-test", async (req, res) => {
  try {
    const stored = await readAigisConfigForApi(VAULT_ROOT);
    const existingToken = stored.hasToken ? (await loadConfig(VAULT_ROOT)).aigis?.authToken : undefined;

    const endpoint: string | undefined = req.body?.endpoint || stored.endpoint;
    const authToken: string | undefined = req.body?.authToken || existingToken;
    const submitTool: string = req.body?.submitTool || stored.submitTool || DEFAULT_AIGIS_SUBMIT_TOOL;

    if (!endpoint) {
      return res.json({ ok: false, tools: [], hasSubmitTool: false, error: "No endpoint configured" });
    }

    const config: AigisConfig = { endpoint, authToken, submitTool, enabled: true };
    const result = await testAigisConnection(config);
    res.json(result);
  } catch (e: any) {
    res.json({ ok: false, tools: [], hasSubmitTool: false, error: e.message });
  }
});

/**
 * Retries a previously failed/skipped Aigis submission for a given (already
 * approved) update — re-reads `vault/aigis/<theme>.md` and calls the
 * configured submit tool again, appending a new outcome record to
 * `submissions.jsonl` (see `resubmitAigisRollup` in `src/lib/aigis-submit.ts`
 * and task-17 brief §B).
 */
app.post("/api/aigis-resubmit/:updateId", async (req, res) => {
  const updateId = req.params.updateId;
  if (!/^[\w-]+$/.test(updateId)) return res.status(400).json({ ok: false, error: "Invalid update id" });
  try {
    const outcome = await resubmitAigisRollup(VAULT_ROOT, updateId);
    if (!outcome.ok) return res.status(outcome.status).json({ ok: false, error: outcome.error });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


/**
 * Last recorded Aigis submission outcome (any update), for the Settings
 * "Connect Aigis" card — shown alongside the connection status so the user
 * doesn't have to go dig through the Review tab to see what happened.
 */
app.get("/api/aigis-last-submission", async (_req, res) => {
  try {
    res.json(await readAigisLastSubmissionForApi(VAULT_ROOT));
  } catch (e: any) {
    res.json({ found: false, error: e.message });
  }
});

app.get("/api/vault-path", (_req, res) => {
  res.json({ path: VAULT_ROOT });
});

app.get("/api/hot-entries", async (_req, res) => {
  try {
    const files = await readdir(hotDir);
    const entries: Array<{ id: string; timestamp: string; log: string; theme?: string; source?: string }> = [];

    for (const file of files) {
      if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
      const content = await readFile(join(hotDir, file), "utf-8");
      const blocks = parseActivityBlocks(content);
      blocks.forEach((block, i) => {
        entries.push({ id: `daily:${file}:${i}`, ...block });
      });
    }

    // Also scan vault/hot/ingest/ for ingested documents
    const ingestDir = join(hotDir, "ingest");
    try {
      const ingestFiles = await readdir(ingestDir);
      for (const file of ingestFiles) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(ingestDir, file);
        const content = await readFile(filePath, "utf-8");
        const fileStat = await stat(filePath);
        entries.push({
          id: `ingest:${file}`,
          timestamp: fileStat.mtime.toISOString(),
          log: content,
          theme: "ingested",
          source: file.replace(/\.md$/, ""),
        });
      }
    } catch { /* ingest dir may not exist */ }

    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(entries);
  } catch {
    res.json([]);
  }
});

app.delete("/api/hot-entries/:id", async (req, res) => {
  const id = req.params.id;
  try {
    if (id.startsWith("ingest:")) {
      // Delete ingested file
      const filename = id.slice("ingest:".length);
      if (filename.includes("/") || filename.includes("..")) return res.status(400).json({ error: "Invalid id" });
      await rm(join(hotDir, "ingest", filename));
      return res.json({ ok: true });
    }

    if (id.startsWith("daily:")) {
      // Remove a block from a daily log file
      const parts = id.split(":");
      const file = parts[1];
      const blockIndex = parseInt(parts[2]);
      if (file.includes("/") || file.includes("..")) return res.status(400).json({ error: "Invalid id" });
      const filePath = join(hotDir, file);
      const content = await readFile(filePath, "utf-8");
      const blocks = splitHotFileBlocks(content).filter((b) => b.trim());
      blocks.splice(blockIndex, 1);
      if (blocks.length === 0) {
        await rm(filePath);
      } else {
        await writeFile(filePath, joinHotFileBlocks(blocks), "utf-8");
      }
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Unknown id format" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/warm-themes", async (_req, res) => {
  try {
    const vault = new Vault(VAULT_ROOT);
    await vault.init();
    const docs = await readAllThemes(vault);
    const themes = docs
      .map((d) => ({
        theme: d.theme,
        content: d.content,
        lastUpdated: d.lastUpdated,
        type: d.type ?? "project",
        skills: d.skills ?? [],
        status: d.status,
        statusReason: d.statusReason,
      }))
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    res.json(themes);
  } catch {
    res.json([]);
  }
});


// Backs the Themes page's search box.
app.get("/api/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  try {
    res.json(await searchThemesForApi(VAULT_ROOT, q));
  } catch {
    res.json([]);
  }
});

app.get("/api/skills", async (_req, res) => {
  try {
    const builtinDir = join(process.cwd(), "..", "core", "builtin-skills");
    const userDir = join(VAULT_ROOT, "skills");
    const discovered = await discoverSkills([builtinDir, userDir]);
    const vault = new Vault(VAULT_ROOT);
    await vault.init();

    const skills = await Promise.all(discovered.map(async (skill) => {
      let { eligible, missing } = await checkEligibility(skill);
      const state = await loadSkillState(vault, skill.name);

      // Check config: if skill has config fields WITHOUT defaults, verify they're saved.
      // Empty-string defaults count as "has a default" (the skill can run with no value).
      const configFields = Array.isArray(skill.config) ? skill.config : [];
      const fieldsNeedingInput = configFields.filter((f: any) => f.default === undefined);
      if (eligible && fieldsNeedingInput.length > 0) {
        let saved: Record<string, string> = {};
        try {
          const configPath = join(VAULT_ROOT, "vault", "skill-config", `${skill.name}.json`);
          const raw = await readFile(configPath, "utf-8");
          saved = JSON.parse(raw);
        } catch { /* no saved config */ }

        for (const f of fieldsNeedingInput) {
          const key = (f as any).key;
          if (!saved[key]) {
            eligible = false;
            missing.push(`config: ${key}`);
          }
        }
      }

      return {
        name: skill.name,
        description: skill.description,
        schedule: skill.schedule ?? null,
        lookback: skill.lookback ?? "24h",
        requires: {
          bins: skill.requires?.bins ?? [],
          env: skill.requires?.env ?? [],
        },
        body: skill.body ?? "",
        setupGuide: skill.setupGuide ?? "",
        config: configFields,
        isBuiltin: skill.location.includes("builtin-skills"),
        eligible,
        missing,
        lastRunAt: state?.lastRunAt ?? null,
        lastStatus: state?.lastStatus ?? "never",
        entriesCollected: state?.entriesCollected ?? 0,
        lastError: state?.lastError,
      };
    }));

    res.json(skills);
  } catch (e: any) {
    res.json([]);
  }
});

app.post("/api/skills/install", async (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: "repo is required" });
  try {
    const { stderr, stdout } = await execFileAsync("npx", ["skillsadd", repo], {
      cwd: VAULT_ROOT,
      timeout: 60000,
      env: process.env,
    });
    res.json({ output: stdout || stderr || "Skill installed." });
  } catch (e: any) {
    res.json({ output: e.stderr || e.stdout || e.message });
  }
});

app.delete("/api/skills/:name", async (req, res) => {
  if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: "Invalid skill name" });
  const skillDir = join(VAULT_ROOT, "skills", req.params.name);
  try {
    await rm(skillDir, { recursive: true });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/skills/:name/run", async (req, res) => {
  if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: "Invalid skill name" });
  try {
    await runSkillByName(req.params.name, VAULT_ROOT);
    res.json({ output: "Skill completed." });
  } catch (e: any) {
    res.json({ output: e.message });
  }
});

app.post("/api/validate-models", async (req, res) => {
  const { provider, baseUrl } = req.body;
  if (!provider) return res.status(400).json({ valid: false, error: "provider is required", models: [] });
  // Use the client-supplied key if present (user typing a new one), else the stored key.
  const apiKey: string | undefined = req.body.apiKey || (provider === "ollama" ? undefined : await readStoredApiKey());

  try {
    let models: Array<{ id: string; name: string }> = [];

    if (provider === "anthropic") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 401 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      models = (data.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name ?? m.id }));
    } else if (provider === "openai") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 401 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      const chatPrefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
      models = (data.data ?? [])
        .filter((m: any) => chatPrefixes.some((p) => m.id.startsWith(p)))
        .map((m: any) => ({ id: m.id, name: m.id }));
    } else if (provider === "gemini") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 400 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      // Filter to text generation models only — exclude TTS, embedding, vision-only, robotics
      const excludePatterns = /tts|embed|vision|image|clip|robotics|lyria|nano|gemma|imagen/i;
      models = (data.models ?? [])
        .filter((m: any) => {
          const methods = m.supportedGenerationMethods ?? [];
          const name = m.displayName ?? m.name ?? "";
          return methods.includes("generateContent") && !excludePatterns.test(name);
        })
        .map((m: any) => ({ id: (m.name ?? "").replace("models/", ""), name: m.displayName ?? m.name }));
    } else if (provider === "mistral") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch("https://api.mistral.ai/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 401 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      models = (data.data ?? []).map((m: any) => ({ id: m.id, name: m.id }));
    } else if (provider === "ollama") {
      const url = baseUrl || "http://localhost:11434";
      const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return res.json({ valid: false, error: `Cannot connect to Ollama at ${url}`, models: [] });
      const data = await resp.json();
      models = (data.models ?? []).map((m: any) => ({ id: m.name, name: m.name }));
    } else {
      return res.json({ valid: false, error: `Unknown provider: ${provider}`, models: [] });
    }

    models.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ valid: true, models });
  } catch (e: any) {
    const msg = e.name === "TimeoutError" ? "Connection timed out" : `Cannot connect to ${provider}`;
    res.json({ valid: false, error: msg, models: [] });
  }
});

app.post("/api/test-model", async (req, res) => {
  const { provider, model, baseUrl } = req.body;
  if (!provider || !model) return res.status(400).json({ success: false, error: "provider and model are required" });
  // Fall back to the stored key when the client doesn't send one (masked UI).
  const apiKey: string | undefined = req.body.apiKey || (provider === "ollama" ? undefined : await readStoredApiKey());

  try {
    const { createProvider } = await import("../core/dist/index.js");
    const llmProvider = createProvider({
      vaultPath: VAULT_ROOT,
      themes: [],
      llm: { provider, model, apiKey, baseUrl },
    } as any);

    const response = await llmProvider.complete({
      model,
      prompt: "Say hello in exactly one word.",
      maxTokens: 16,
    });

    res.json({ success: true, response: response.trim() });
  } catch (e: any) {
    res.json({ success: false, error: e.message ?? String(e) });
  }
});

// --- Logging ---

const logsDir = join(VAULT_ROOT, "vault", "logs");

async function cleanOldLogs() {
  try {
    const files = await readdir(logsDir).catch(() => []);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const file of files) {
      if (file.endsWith(".jsonl") && file.slice(0, 10) < cutoffStr) {
        await rm(join(logsDir, file)).catch(() => {});
      }
    }
  } catch { /* ignore cleanup errors */ }
}

app.post("/api/logs", async (req, res) => {
  const entry = req.body;
  if (!entry?.message) return res.status(400).json({ error: "message is required" });

  try {
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `${date}.jsonl`);
    const line = JSON.stringify({
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level ?? "info",
      message: entry.message,
      detail: entry.detail,
    }) + "\n";
    await appendFile(logFile, line, "utf-8");
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Ensure logs dir exists; clean logs older than 30 days on startup and daily
mkdir(logsDir, { recursive: true }).catch(() => {});
cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);

app.get("/api/logs", async (_req, res) => {
  const level = _req.query.level as string | undefined;

  try {
    const files = await readdir(logsDir).catch(() => []);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();

    const entries: any[] = [];
    // Read last 7 days of logs
    for (const file of jsonlFiles.slice(0, 7)) {
      const raw = await readFile(join(logsDir, file), "utf-8");
      for (const line of raw.split("\n").filter((l) => l.trim())) {
        try {
          const entry = JSON.parse(line);
          if (!level || entry.level === level) entries.push(entry);
        } catch { /* skip malformed lines */ }
      }
    }

    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    res.json(entries.slice(0, 500));
  } catch {
    res.json([]);
  }
});

// Surfaces the most recent Dream Pipeline run's token/call/retry totals for
// the Dashboard. The pipeline always runs as a subprocess (manual trigger or
// orchestrator), so this is the only channel back to the UI — it logs a
// dedicated "Dream pipeline usage" entry (see packages/dream/src/index.ts)
// whose `detail` is a JSON-encoded UsageTotals; we just find the latest one.
app.get("/api/dream-usage", async (_req, res) => {
  try {
    const files = await readdir(logsDir).catch(() => []);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();

    for (const file of jsonlFiles.slice(0, 7)) {
      const raw = await readFile(join(logsDir, file), "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.message === "Dream pipeline usage" && entry.detail) {
            const usage = JSON.parse(entry.detail);
            return res.json({ usage, at: entry.timestamp });
          }
        } catch { /* skip malformed lines */ }
      }
    }
    res.json({ usage: null, at: null });
  } catch {
    res.json({ usage: null, at: null });
  }
});

app.get("/api/project-path", (_req, res) => {
  // Resolve from server.ts location (packages/ui/) → repo root
  res.json({ path: join(process.cwd(), "..", "..") });
});

// --- Claude Desktop MCP integration ---

function getClaudeConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: // linux
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

const CLAUDE_CONFIG_PATH = getClaudeConfigPath();
const mcpServerPath = join(process.cwd(), "..", "mcp-server", "dist", "index.js");

app.get("/api/claude-desktop-status", async (_req, res) => {
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    const connected = !!config?.mcpServers?.openpulse;
    res.json({ installed: true, connected, configPath: CLAUDE_CONFIG_PATH });
  } catch {
    res.json({ installed: false, connected: false, configPath: CLAUDE_CONFIG_PATH });
  }
});

app.post("/api/claude-desktop-connect", async (_req, res) => {
  try {
    // Read existing config or start fresh
    let config: any = { mcpServers: {} };
    try {
      const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
      config = JSON.parse(raw);
      if (!config.mcpServers) config.mcpServers = {};
    } catch { /* no existing config */ }

    // Add or update the openpulse entry
    config.mcpServers.openpulse = {
      command: "node",
      args: [mcpServerPath],
    };

    // Ensure directory exists
    await mkdir(dirname(CLAUDE_CONFIG_PATH), { recursive: true });
    await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/claude-desktop-disconnect", async (_req, res) => {
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    if (config?.mcpServers?.openpulse) {
      delete config.mcpServers.openpulse;
      await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Directory browser ---

app.get("/api/browse-dirs", async (req, res) => {
  let dir = (req.query.path as string) ?? process.env.HOME ?? "/";
  // Expand ~ to home directory
  if (dir.startsWith("~")) dir = dir.replace("~", process.env.HOME ?? "");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .slice(0, 100);
    res.json({ path: dir, dirs });
  } catch {
    res.json({ path: dir, dirs: [] });
  }
});

// --- Skill config ---

const skillConfigDir = join(VAULT_ROOT, "vault", "skill-config");

app.get("/api/skill-config/:name", async (req, res) => {
  if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: "Invalid skill name" });
  try {
    const raw = await readFile(join(skillConfigDir, `${req.params.name}.json`), "utf-8");
    res.json(JSON.parse(raw));
  } catch {
    res.json({});
  }
});


app.post("/api/skill-config/:name", async (req, res) => {
  if (!SAFE_NAME.test(req.params.name)) return res.status(400).json({ error: "Invalid skill name" });
  try {
    await mkdir(skillConfigDir, { recursive: true });
    const configPath = join(skillConfigDir, `${req.params.name}.json`);

    // Compare against previous config to detect scope expansion (new repos,
    // spaces, vault paths, etc.). When detected, reset the collector's
    // lastRunAt so the next run uses firstRunLookback to backfill the new
    // entries' history — otherwise newly-added scope misses the firstRunLookback
    // window because the collector's overall lastRunAt is recent.
    let scopeAdded = false;
    try {
      const prev = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, string>;
      scopeAdded = configAddsNewScope(prev, req.body as Record<string, string>);
    } catch { /* no prior config — first save, lastRunAt is already null */ }

    await writeFile(configPath, JSON.stringify(req.body, null, 2), "utf-8");

    if (scopeAdded) {
      const statePath = join(VAULT_ROOT, "vault", "collector-state", `${req.params.name}.json`);
      try {
        const state = JSON.parse(await readFile(statePath, "utf-8"));
        state.lastRunAt = null;
        await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
        console.error(`[server] config: ${req.params.name} scope expanded — reset lastRunAt for firstRunLookback backfill`);
      } catch { /* no prior state */ }
    }

    res.json({ ok: true, backfillScheduled: scopeAdded });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// --- Confluence space discovery ---

const ATLASSIAN_DOMAIN = /^[\w-]+(\.[\w-]+)*\.atlassian\.net$/;

app.post("/api/confluence-activity/spaces", async (req, res) => {
  const { domain, email, token } = req.body as { domain?: string; email?: string; token?: string };
  if (!domain || !email || !token) {
    return res.status(400).json({ error: "domain, email, and token are required" });
  }
  if (!ATLASSIAN_DOMAIN.test(domain)) {
    return res.status(400).json({ error: "domain must be an *.atlassian.net host" });
  }
  try {
    const resp = await fetch(
      `https://${domain}/wiki/rest/api/space?limit=250&type=global`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Confluence returned ${resp.status}` });
    }
    const data = await resp.json() as { results: Array<{ key: string; name: string }> };
    const spaces = (data.results ?? [])
      .map((s) => ({ key: s.key, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(spaces);
  } catch (e: any) {
    const msg = e.name === "TimeoutError" ? "Connection timed out" : e.message;
    res.status(500).json({ error: msg });
  }
});

// --- Obsidian vault discovery ---

app.get("/api/obsidian-notes/vaults", async (_req, res) => {
  const home = process.env.HOME ?? "";
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const candidates = [
    join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    join(xdg, "obsidian", "obsidian.json"),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    try { await stat(candidate); configPath = candidate; break; }
    catch { /* try next */ }
  }

  if (!configPath) {
    return res.json({ vaults: [], error: "obsidian.json not found at standard locations" });
  }

  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { vaults?: Record<string, { path: string }> };
    const vaults = Object.values(parsed.vaults ?? {})
      .map((v) => {
        const trimmed = v.path.replace(/\/$/, "");
        const name = trimmed.split("/").pop() ?? trimmed;
        return { name, path: v.path };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ vaults });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ vaults: [], error: `Failed to read obsidian.json: ${msg}` });
  }
});

// --- GitHub repo access check ---

const VALID_HOSTNAME = /^[\w][\w.-]*\.[a-zA-Z]{2,}$/;
// Matches: https://host/owner/repo[.git][/anything]
const GITHUB_URL = /^https?:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+?)(?:\.git)?(\/.*)?$/;

app.post("/api/github-activity/check-repo", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url?.trim()) return res.status(400).json({ error: "url is required" });

  const match = url.trim().match(GITHUB_URL);
  if (!match) return res.status(400).json({ error: "Not a valid GitHub repo URL" });

  const [, host, repoPath] = match;
  if (host !== "github.com" && !VALID_HOSTNAME.test(host)) {
    return res.status(400).json({ error: "Invalid hostname in URL" });
  }

  const ghArgs = [
    "api", `repos/${repoPath}`,
    "--jq", '{"name": .full_name, "description": (.description // ""), "visibility": .visibility}',
  ];
  if (host !== "github.com") ghArgs.push("--hostname", host);

  try {
    const { stdout } = await execFileAsync("gh", ghArgs, { timeout: 10000 });
    res.json(JSON.parse(stdout.trim()));
  } catch (e: any) {
    if (e.code === "ENOENT") return res.status(503).json({ error: "gh CLI not found — install from cli.github.com" });
    const stderr: string = e.stderr ?? "";
    if (stderr.includes("Could not resolve") || stderr.includes("no such host")) {
      return res.status(503).json({ error: "Cannot reach host" });
    }
    // 404 = repo not found or no access; gh exits non-zero
    if (stderr.includes("Not Found") || (e.exitCode !== undefined && e.exitCode !== 0)) {
      return res.status(404).json({ error: "Repo not found or no access — check gh auth login" });
    }
    res.status(500).json({ error: e.name === "TimeoutError" ? "Connection timed out" : (stderr || e.message) });
  }
});

// --- Dependency fix runner ---

// Whitelisted install commands — only these can be executed
const INSTALL_COMMANDS: Record<string, { cmd: string; args: string[] }> = {
  "gh":   { cmd: "brew", args: ["install", "gh"] },
  "gog":  { cmd: "go",   args: ["install", "github.com/slashdevops/gog@latest"] },
  "git":  { cmd: "brew", args: ["install", "git"] },
  "curl": { cmd: "brew", args: ["install", "curl"] },
};

app.post("/api/install-dependency", async (req, res) => {
  const { dep } = req.body;
  if (!dep || !INSTALL_COMMANDS[dep]) {
    return res.status(400).json({ success: false, error: `Unknown or unsupported dependency: ${dep}. Supported: ${Object.keys(INSTALL_COMMANDS).join(", ")}` });
  }

  const { cmd, args } = INSTALL_COMMANDS[dep];
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 120000 });
    const output = (stdout + "\n" + stderr).trim();

    // Verify it actually installed
    try {
      await execFileAsync("which", [dep], { timeout: 3000 });
      res.json({ success: true, output: output || `${dep} installed successfully.` });
    } catch {
      res.json({ success: false, output: output || `${dep} install completed but binary not found on PATH.` });
    }
  } catch (e: any) {
    const output = (e.stdout ?? "") + "\n" + (e.stderr ?? "") + "\n" + (e.message ?? "");
    res.json({ success: false, output: output.trim() });
  }
});

// --- Orchestrator ---

const orchestratorCallbacks: OrchestratorCallbacks = {
  async runCollector(skillName: string): Promise<void> {
    await runSkillByName(skillName, VAULT_ROOT);
  },
  async runDreamPipeline(): Promise<void> {
    const dreamBin = join(process.cwd(), "..", "dream", "dist", "index.js");
    await execFileAsync("node", [dreamBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 300000,
    });
  },
  async runLintPipeline(): Promise<void> {
    const lintBin = join(process.cwd(), "..", "dream", "dist", "lint-cli.js");
    await execFileAsync("node", [lintBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 120000,
    });
  },
  async runCompactionPipeline(themes?: string[]): Promise<void> {
    const compactBin = join(process.cwd(), "..", "dream", "dist", "compact-cli.js");
    const args = [compactBin, ...(themes ?? [])];
    await execFileAsync("node", args, {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 300000,
    });
  },
  async runSchemaEvolutionPipeline(): Promise<void> {
    const schemaBin = join(process.cwd(), "..", "dream", "dist", "schema-evolve-cli.js");
    await execFileAsync("node", [schemaBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 300000,
    });
  },
  async runAigisRollupPipeline(): Promise<"drafted" | "no-activity"> {
    const rollupBin = join(process.cwd(), "..", "dream", "dist", "aigis-rollup-cli.js");
    const { stdout } = await execFileAsync("node", [rollupBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 300000,
    });
    // The CLI prints its outcome on its own stdout line (see aigis-rollup-cli.ts's
    // main()) since this callback's return value is what surfaces through
    // Orchestrator.triggerAigisRollup() to the Schedule page's "Run Now" feedback.
    // Default to "drafted" if the marker is ever missing — matches this pipeline's
    // pre-existing behavior of treating a clean subprocess exit as success.
    return stdout.includes("OPENPULSE_ROLLUP_OUTCOME=no-activity") ? "no-activity" : "drafted";
  },
  async isAigisEnabled(): Promise<boolean> {
    const config = await loadConfig(VAULT_ROOT);
    return Boolean(config.aigis?.enabled);
  },
  async getSkillNames(): Promise<string[]> {
    const builtinDir = join(process.cwd(), "..", "core", "builtin-skills");
    const userDir = join(VAULT_ROOT, "skills");
    const skills = await discoverSkills([builtinDir, userDir]);
    return skills.map(s => s.name);
  },
  async isDreamLockHeld(): Promise<boolean> {
    // Vault construction is pure path setup (no I/O) — safe to build a
    // throwaway instance here rather than threading a shared one through.
    return isDreamLockHeld(new Vault(VAULT_ROOT));
  },
};

const orchestrator = new Orchestrator(VAULT_ROOT, orchestratorCallbacks);
orchestrator.start().catch((err) =>
  console.error("[openpulse-ui] Orchestrator failed to start:", err)
);

app.get("/api/orchestrator-status", (_req, res) => {
  res.json({ running: orchestrator.isRunning(), ...orchestrator.getStatus() });
});

app.post("/api/orchestrator-schedule", async (req, res) => {
  const { skill, schedules, enabled } = req.body;
  if (!skill || !Array.isArray(schedules) || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "skill, schedules, and enabled are required" });
  }
  try {
    await orchestrator.updateSchedule(skill, schedules, enabled);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orchestrator-run", async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: "target is required" });
  try {
    const message = await orchestrator.triggerRun(target);
    res.json({ ok: true, message });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orchestrator-toggle", async (req, res) => {
  const { target, enabled } = req.body;
  if (!target || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "target and enabled are required" });
  }
  try {
    await orchestrator.toggleSchedule(target, enabled);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Warm the search index on startup if it hasn't been built yet (fresh vault,
// or an upgrade from before the index existed) — kicked off in the
// background so it never gates server startup on a full vault scan.
// Skipped under vitest: UI tests import this module for its exported
// helpers (see test/*.test.ts), and without this guard every `vitest run`
// would stat/rebuild the index at the REAL VAULT_ROOT (typically
// ~/OpenPulseAI/vault) as an import side effect, writing
// .search-index.sqlite there — never desired for a test run.
if (!process.env.VITEST) void (async () => {
  try {
    const vault = new Vault(VAULT_ROOT);
    await vault.init();
    const exists = await stat(vault.searchIndexPath).then(() => true).catch(() => false);
    if (!exists) {
      console.log("[openpulse-ui] Search index missing — rebuilding in background...");
      await rebuildIndex(vault);
      console.log("[openpulse-ui] Search index rebuild complete.");
    }
  } catch (err) {
    console.error("[openpulse-ui] Background search index rebuild failed:", err);
  }
})();

const server = await listenWithFallback(app, HOST, REQUESTED_PORT);
const PORT = (server.address() as AddressInfo).port;
const discoveryPath = await writeDiscoveryFile(VAULT_ROOT, PORT);

console.log(`[openpulse-ui] Dev API server running on http://${HOST}:${PORT}`);
console.log(`[openpulse-ui] Vault root: ${VAULT_ROOT}`);
if (process.env.OPENPULSE_API_TOKEN) {
  console.log(`[openpulse-ui] /api auth: using OPENPULSE_API_TOKEN from the environment.`);
} else {
  console.log(`[openpulse-ui] /api auth: token auto-generated at ${tokenPath(VAULT_ROOT)} (delete to rotate).`);
}
const exposed = HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1";
if (exposed) {
  console.warn(
    `[openpulse-ui] WARNING: bound to ${HOST} — /api is reachable off this machine. ` +
    `It IS authenticated, but keep the token file (or OPENPULSE_API_TOKEN) secret.`,
  );
}
// Readiness signal for the Rust sidecar supervisor — printed exactly once,
// after the server is actually listening. Parsed verbatim; don't reformat.
console.log(`OPENPULSE_SERVER_READY port=${PORT}`);

let closed = false;

/** Stops the orchestrator, closes the HTTP server, and removes the discovery
 *  file. Idempotent (guarded by `closed`) — safe to call from both a signal
 *  handler and an explicit ServerHandle.close(), and safe to call twice. */
async function cleanup(): Promise<void> {
  if (closed) return;
  closed = true;
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("SIGINT", onSigint);
  try {
    await orchestrator.stop();
  } catch (err) {
    console.error("[openpulse-ui] Orchestrator stop failed:", err);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(discoveryPath, { force: true }).catch(() => {});
}

function onSigterm(): void {
  void (async () => {
    console.log("[openpulse-ui] Received SIGTERM, shutting down...");
    await cleanup();
    process.exit(0);
  })();
}

function onSigint(): void {
  void (async () => {
    console.log("[openpulse-ui] Received SIGINT, shutting down...");
    await cleanup();
    process.exit(0);
  })();
}

process.on("SIGTERM", onSigterm);
process.on("SIGINT", onSigint);

return { app, server, port: PORT, vaultRoot: VAULT_ROOT, close: cleanup };
}

// --- CLI entry ---

/** Parses `--port <n>` or `--port=<n>` from argv (sidecar launch args). */
function parseCliPort(): number | undefined {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith("--port="));
  if (eq) {
    const n = Number(eq.slice("--port=".length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const idx = args.indexOf("--port");
  if (idx !== -1 && args[idx + 1]) {
    const n = Number(args[idx + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

// Boots the server when this file is run directly — dev (`npx tsx
// server.ts`) or the bundled sidecar binary (`node openpulse-ui-server.cjs`,
// no separate CLI wrapper needed) — but never as an import side effect.
// Deliberately NOT an import.meta-based "is this the main module" check:
// esbuild empties `import.meta.url` when bundling to CJS (the sidecar build,
// see scripts/build-sidecar-ui.sh), which would make that check always
// false in the bundled binary. The existing VITEST guard (already used for
// the search-index warm-up above) is sufficient on its own — vitest always
// sets VITEST=true, and neither the dev flow nor the sidecar ever do.
if (!process.env.VITEST) {
  startServer({ port: parseCliPort() }).catch((err) => {
    console.error("[openpulse-ui] Failed to start server:", err);
    process.exit(1);
  });
}
