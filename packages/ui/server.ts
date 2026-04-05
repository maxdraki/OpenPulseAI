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
import { load as loadYaml } from "js-yaml";
import { Orchestrator, type OrchestratorCallbacks } from "../core/dist/index.js";

const execFileAsync = promisify(execFile);

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const PORT = 3001;

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
      const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GEMINI_API_KEY",
        ollama: "",
      };
      console.log(`[server] API key for ${provider} received (${apiKey.slice(0, 6)}...). Set ${envMap[provider]} env var for the dream pipeline.`);
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
    const entries: Array<{ timestamp: string; log: string; theme?: string; source?: string }> = [];

    for (const file of files) {
      if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
      const content = await readFile(join(hotDir, file), "utf-8");
      const blocks = content.split(/\n---\n/).filter((b) => b.trim());

      for (const block of blocks) {
        const tsMatch = block.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/m);
        const themeMatch = block.match(/^\*\*Theme:\*\*\s*(.+)/m);
        const sourceMatch = block.match(/^\*\*Source:\*\*\s*(.+)/m);
        const logLines = block
          .split("\n")
          .filter((l) => !l.startsWith("## ") && !l.startsWith("**Theme:") && !l.startsWith("**Source:") && l.trim());

        if (tsMatch && logLines.length > 0) {
          entries.push({
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
    // Discover skills from builtin + user dirs
    const builtinDir = join(process.cwd(), "..", "skills", "builtin");
    const userDir = join(VAULT_ROOT, "skills");

    const skills: any[] = [];

    // Scan both directories
    for (const dir of [builtinDir, userDir]) {
      try {
        const dirStat = await stat(dir).catch(() => null);
        if (!dirStat || !dirStat.isDirectory()) continue;

        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = join(dir, entry.name, "SKILL.md");
          try {
            const content = await readFile(skillFile, "utf-8");
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/);
            if (!fmMatch) continue;

            const parsed = loadYaml(fmMatch[1]) as any;
            if (!parsed?.name || !parsed?.description) continue;

            const requires = parsed.requires ?? {};
            const skill: any = {
              name: parsed.name,
              description: parsed.description,
              schedule: parsed.schedule ?? null,
              lookback: parsed.lookback ?? "24h",
              requires: {
                bins: requires.bins ?? [],
                env: requires.env ?? [],
              },
              isBuiltin: dir === builtinDir,
              eligible: true,
              missing: [] as string[],
              lastRunAt: null,
              lastStatus: "never",
              entriesCollected: 0,
            };

            // Check eligibility
            for (const bin of skill.requires.bins) {
              try {
                await execFileAsync("which", [bin], { timeout: 3000 });
              } catch {
                skill.eligible = false;
                skill.missing.push(`bin: ${bin}`);
              }
            }
            for (const env of skill.requires.env) {
              if (!process.env[env]) {
                skill.eligible = false;
                skill.missing.push(`env: ${env}`);
              }
            }

            // Merge collector state
            try {
              const stateRaw = await readFile(join(VAULT_ROOT, "vault", "collector-state", `${skill.name}.json`), "utf-8");
              const state = JSON.parse(stateRaw);
              skill.lastRunAt = state.lastRunAt;
              skill.lastStatus = state.lastStatus;
              skill.entriesCollected = state.entriesCollected;
              skill.lastError = state.lastError;
            } catch { /* no state yet */ }

            skills.push(skill);
          } catch { /* skip invalid skills */ }
        }
      } catch { /* dir doesn't exist */ }
    }

    // Deduplicate by name (user overrides builtin)
    const skillMap = new Map(skills.map(s => [s.name, s]));
    res.json(Array.from(skillMap.values()));
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
  const skillDir = join(VAULT_ROOT, "skills", req.params.name);
  try {
    await rm(skillDir, { recursive: true });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/skills/:name/run", async (req, res) => {
  try {
    const skillsBin = join(process.cwd(), "..", "skills", "dist", "index.js");
    const { stderr } = await execFileAsync("node", [skillsBin, "--run", req.params.name], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 120000,
    });
    res.json({ output: stderr || "Skill completed." });
  } catch (e: any) {
    res.json({ output: e.stderr || e.message });
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
      models = (data.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => ({ id: (m.name ?? "").replace("models/", ""), name: m.displayName ?? m.name }));
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
    // Set API key in env so createProvider can find it
    const envMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      gemini: "GEMINI_API_KEY",
    };
    const envVar = envMap[provider];
    if (apiKey && envVar) process.env[envVar] = apiKey;

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

// --- Orchestrator ---

const orchestratorCallbacks: OrchestratorCallbacks = {
  async runCollector(skillName: string): Promise<void> {
    const skillsBin = join(process.cwd(), "..", "skills", "dist", "index.js");
    await execFileAsync("node", [skillsBin, "--run", skillName], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 120000,
    });
  },
  async runDreamPipeline(): Promise<void> {
    const dreamBin = join(process.cwd(), "..", "dream", "dist", "index.js");
    await execFileAsync("node", [dreamBin], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 300000,
    });
  },
  async getSkillNames(): Promise<string[]> {
    const builtinDir = join(process.cwd(), "..", "skills", "builtin");
    const userDir = join(VAULT_ROOT, "skills");
    const names: string[] = [];

    for (const dir of [builtinDir, userDir]) {
      try {
        const dirStat = await stat(dir).catch(() => null);
        if (!dirStat?.isDirectory()) continue;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = join(dir, entry.name, "SKILL.md");
          try {
            await stat(skillFile);
            names.push(entry.name);
          } catch { /* no SKILL.md */ }
        }
      } catch { /* dir doesn't exist */ }
    }

    // Deduplicate (user overrides builtin by same directory name)
    return [...new Set(names)];
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
