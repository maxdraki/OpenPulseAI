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

app.listen(PORT, () => {
  console.log(`[openpulse-ui] Dev API server running on http://localhost:${PORT}`);
  console.log(`[openpulse-ui] Vault root: ${VAULT_ROOT}`);
});
