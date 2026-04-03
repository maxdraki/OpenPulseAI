/**
 * Dev API server — bridges the UI to the real vault filesystem.
 * Replaces mock data in development (no Tauri needed).
 *
 * Run: npx tsx server.ts
 */
import express from "express";
import cors from "cors";
import { readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  const hotCount = await countFiles(hotDir, ".md");
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
    res.json({
      provider: providerMatch?.[1] ?? "anthropic",
      model: modelMatch?.[1]?.trim() ?? "claude-sonnet-4-5-20250929",
    });
  } catch {
    res.json({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
  }
});

app.post("/api/save-llm-settings", async (req, res) => {
  const { provider, model, apiKey } = req.body;
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
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

    await writeFile(configPath, yaml, "utf-8");

    // Set API key as env var hint (Stronghold when Tauri is available)
    if (apiKey) {
      const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GEMINI_API_KEY",
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

app.get("/api/sources", async (_req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const { parse } = await import("yaml");
    const raw = await readFile(configPath, "utf-8");
    const parsed = parse(raw);
    const sources = (parsed?.sources ?? []).map((s: any) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      schedule: s.schedule ?? "0 23 * * *",
      lookback: s.lookback ?? "24h",
      template: s.template ?? null,
      enabled: s.enabled ?? true,
    }));

    // Merge collector state
    const stateDir = join(VAULT_ROOT, "vault", "collector-state");
    for (const source of sources) {
      try {
        const stateRaw = await readFile(join(stateDir, `${source.name}.json`), "utf-8");
        const state = JSON.parse(stateRaw);
        source.lastRunAt = state.lastRunAt;
        source.lastStatus = state.lastStatus;
        source.entriesCollected = state.entriesCollected;
        source.lastError = state.lastError;
      } catch {
        source.lastRunAt = null;
        source.lastStatus = "never";
        source.entriesCollected = 0;
      }
    }

    res.json(sources);
  } catch {
    res.json([]);
  }
});

app.post("/api/sources", async (req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const { parse, stringify } = await import("yaml");
    let config: any = {};
    try {
      config = parse(await readFile(configPath, "utf-8")) ?? {};
    } catch { /* new config */ }

    if (!config.sources) config.sources = [];
    config.sources.push(req.body);
    await writeFile(configPath, stringify(config), "utf-8");
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/sources/:name", async (req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const { parse, stringify } = await import("yaml");
    const config = parse(await readFile(configPath, "utf-8")) ?? {};
    if (!config.sources) return res.status(404).json({ error: "No sources configured" });
    const idx = config.sources.findIndex((s: any) => s.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: "Source not found" });
    config.sources[idx] = req.body;
    await writeFile(configPath, stringify(config), "utf-8");
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/sources/:name", async (req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const { parse, stringify } = await import("yaml");
    const config = parse(await readFile(configPath, "utf-8")) ?? {};
    if (!config.sources) return res.status(404).json({ error: "No sources configured" });
    config.sources = config.sources.filter((s: any) => s.name !== req.params.name);
    await writeFile(configPath, stringify(config), "utf-8");
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sources/:name/test", async (req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const { parse } = await import("yaml");
    const config = parse(await readFile(configPath, "utf-8"));
    const source = (config?.sources ?? []).find((s: any) => s.name === req.params.name);
    if (!source) return res.status(404).json({ error: "Source not found" });

    try {
      await execFileAsync("which", [source.command], { timeout: 5000 });
      res.json({ ok: true, message: `Command '${source.command}' found` });
    } catch {
      res.json({ ok: false, error: `Command '${source.command}' not found on PATH` });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sources/:name/collect", async (req, res) => {
  try {
    const collectorBin = join(process.cwd(), "..", "collector", "dist", "index.js");
    const { stderr } = await execFileAsync("node", [collectorBin, "--force", req.params.name], {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 60000,
    });
    res.json({ output: stderr || "Collection completed." });
  } catch (e: any) {
    res.json({ output: e.stderr || e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[openpulse-ui] Dev API server running on http://localhost:${PORT}`);
  console.log(`[openpulse-ui] Vault root: ${VAULT_ROOT}`);
});
