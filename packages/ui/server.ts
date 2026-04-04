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

app.get("/api/skills", async (_req, res) => {
  try {
    // Discover skills from builtin + user dirs
    const builtinDir = join(process.cwd(), "..", "skills", "builtin");
    const userDir = join(VAULT_ROOT, "skills");

    const skills: any[] = [];

    // Scan both directories
    for (const dir of [builtinDir, userDir]) {
      try {
        const { readdir: rd, stat: st } = await import("node:fs/promises");
        const dirStat = await st(dir).catch(() => null);
        if (!dirStat || !dirStat.isDirectory()) continue;

        const entries = await rd(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = join(dir, entry.name, "SKILL.md");
          try {
            const content = await readFile(skillFile, "utf-8");
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/);
            if (!fmMatch) continue;

            const { load } = await import("js-yaml");
            const parsed = load(fmMatch[1]) as any;
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

app.listen(PORT, () => {
  console.log(`[openpulse-ui] Dev API server running on http://localhost:${PORT}`);
  console.log(`[openpulse-ui] Vault root: ${VAULT_ROOT}`);
});
