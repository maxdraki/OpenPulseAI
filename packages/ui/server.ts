/**
 * Dev API server — bridges the UI to the real vault filesystem.
 * Replaces mock data in development (no Tauri needed).
 *
 * Run: npx tsx server.ts
 */
import express from "express";
import cors from "cors";
import { readdir, readFile, writeFile, rm, stat, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Orchestrator, type OrchestratorCallbacks } from "../core/dist/index.js";
import { discoverSkills, checkEligibility, loadCollectorState as loadSkillState } from "../core/dist/skills/index.js";
import { runSkillByName } from "../core/dist/skills/run.js";
import { Vault } from "../core/dist/vault.js";

const execFileAsync = promisify(execFile);

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const PORT = 3001;

/** Guard against path traversal in :name params */
const SAFE_NAME = /^[\w-]+$/;

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  ollama: "",
};

const app = express();
app.use(cors());
app.use(express.json());

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
      hotCount += content.split(/\n---\n/).filter((b) => b.trim()).length;
    }
    // Count ingested documents
    try {
      const ingestFiles = await readdir(join(hotDir, "ingest"));
      hotCount += ingestFiles.filter((f) => f.endsWith(".md")).length;
    } catch { /* ingest dir may not exist */ }
  } catch { /* hot dir may not exist */ }

  const warmCount = await countFiles(warmDir, ".md");
  const pendingCount = await countFiles(pendingDir, ".json");
  res.json({ hotCount, warmCount, pendingCount, vaultExists });
});

app.get("/api/pending-updates", async (_req, res) => {
  try {
    const files = await readdir(pendingDir);
    const updates = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(pendingDir, file), "utf-8");
      const update = JSON.parse(content);
      if (update.status === "pending") updates.push(update);
    }
    updates.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
    res.json(updates);
  } catch {
    res.json([]);
  }
});

app.post("/api/approve-update", async (req, res) => {
  const { id, editedContent } = req.body;
  const pendingPath = join(pendingDir, `${id}.json`);
  try {
    const raw = await readFile(pendingPath, "utf-8");
    const update = JSON.parse(raw);
    const finalContent = editedContent ?? update.proposedContent;

    // Write to warm theme file
    const now = new Date().toISOString();
    const warmContent = `---\ntheme: ${update.theme}\nlastUpdated: ${now}\n---\n\n${finalContent}\n`;
    await writeFile(join(warmDir, `${update.theme}.md`), warmContent, "utf-8");

    // Remove pending file
    await rm(pendingPath);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reject-update", async (req, res) => {
  const { id } = req.body;
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
      timeout: 60000,
    });
    res.json({ output: stderr || "Dream pipeline completed." });
  } catch (e: any) {
    const output = e.stderr || e.message;
    res.json({ output });
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
    res.json({
      provider: providerMatch?.[1] ?? "anthropic",
      model: modelMatch?.[1]?.trim() ?? "claude-sonnet-4-5-20250929",
      apiKey: apiKeyMatch?.[1]?.trim(),
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

    let yaml = "";
    if (themes.length > 0) {
      yaml += `themes:\n${themes.map((t) => `  - ${t}`).join("\n")}\n`;
    }
    yaml += `llm:\n  provider: ${provider}\n  model: ${model}\n`;
    if (apiKey) {
      yaml += `  apiKey: ${apiKey}\n`;
    }
    if (baseUrl) {
      yaml += `  baseUrl: ${baseUrl}\n`;
    }

    await writeFile(configPath, yaml, "utf-8");

    // Set API key as env var hint (Stronghold when Tauri is available)
    if (apiKey) {
      console.log(`[server] API key for ${provider} received (${apiKey.slice(0, 6)}...). Set ${PROVIDER_ENV_KEYS[provider]} env var for the dream pipeline.`);
    }

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
      const blocks = content.split(/\n---\n/).filter((b) => b.trim());

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const tsMatch = block.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m);
        const themeMatch = block.match(/^\*\*Theme:\*\*\s*(.+)/m);
        const sourceMatch = block.match(/^\*\*Source:\*\*\s*(.+)/m);
        const logLines = block
          .split("\n")
          .filter((l) => !l.startsWith("## ") && !l.startsWith("**Theme:") && !l.startsWith("**Source:") && l.trim());

        if (tsMatch && logLines.length > 0) {
          entries.push({
            id: `daily:${file}:${i}`,
            timestamp: tsMatch[1],
            log: logLines.join("\n").trim(),
            theme: themeMatch?.[1],
            source: sourceMatch?.[1],
          });
        }
      }
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
      const blocks = content.split(/\n---\n/).filter((b) => b.trim());
      blocks.splice(blockIndex, 1);
      if (blocks.length === 0) {
        await rm(filePath);
      } else {
        await writeFile(filePath, blocks.join("\n\n---\n") + "\n\n---\n", "utf-8");
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
    const files = await readdir(warmDir, { withFileTypes: true });
    const themes = [];

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const raw = await readFile(join(warmDir, entry.name), "utf-8");
      const themeName = entry.name.replace(/\.md$/, "");

      // Parse frontmatter
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
      let lastUpdated = "";
      if (fmMatch) {
        const luMatch = fmMatch[1].match(/lastUpdated:\s*(.+)/);
        if (luMatch) lastUpdated = luMatch[1].trim();
      }
      const content = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();

      themes.push({ theme: themeName, content, lastUpdated });
    }

    themes.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
    res.json(themes);
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

      // Check config: if skill has config fields WITHOUT defaults, verify they're saved
      const configFields = Array.isArray(skill.config) ? skill.config : [];
      const fieldsNeedingInput = configFields.filter((f: any) => !f.default);
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
  const { provider, apiKey, baseUrl } = req.body;
  if (!provider) return res.status(400).json({ valid: false, error: "provider is required", models: [] });

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
  const { provider, model, apiKey, baseUrl } = req.body;
  if (!provider || !model) return res.status(400).json({ success: false, error: "provider and model are required" });

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

// Clean logs older than 30 days on startup and daily
// Ensure logs dir exists at startup, clean old logs daily
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
    await writeFile(
      join(skillConfigDir, `${req.params.name}.json`),
      JSON.stringify(req.body, null, 2),
      "utf-8"
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
  async getSkillNames(): Promise<string[]> {
    const builtinDir = join(process.cwd(), "..", "core", "builtin-skills");
    const userDir = join(VAULT_ROOT, "skills");
    const skills = await discoverSkills([builtinDir, userDir]);
    return skills.map(s => s.name);
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

app.listen(PORT, () => {
  console.log(`[openpulse-ui] Dev API server running on http://localhost:${PORT}`);
  console.log(`[openpulse-ui] Vault root: ${VAULT_ROOT}`);
});
