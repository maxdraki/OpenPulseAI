#!/usr/bin/env node
import { readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Vault, loadConfig, listThemes, createProvider, initLogger, vaultLog, readTheme, parseActivityBlocks } from "@openpulse/core";
import type { ActivityEntry, ProjectStatus } from "@openpulse/core";
import { classifyEntries } from "./classify.js";
import { synthesizeToPending } from "./synthesize.js";
import { archiveProcessedHotFiles } from "./archive.js";
import { buildBacklinks, writeBacklinksFile } from "./backlinks.js";
import { seedSchema } from "./schema.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  console.error("[dream] Starting Dream Pipeline...");

  const config = await loadConfig(VAULT_ROOT);
  initLogger(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  await seedSchema(vault);
  await vaultLog("info", "Dream pipeline started");

  const provider = createProvider(config);
  const model = config.llm.model;

  const entries = await readHotEntries(vault);
  if (entries.length === 0) {
    console.error("[dream] No hot entries to process. Exiting.");
    return;
  }
  console.error(`[dream] Found ${entries.length} hot entries.`);

  const themes = await listThemes(vault);
  const allThemes = [...new Set([...config.themes, ...themes])];

  const { classified, proposedTypes, conceptCandidates, orphanCandidates, themeMergeProposals } =
    await classifyEntries(entries, allThemes, provider, model);
  console.error(`[dream] Classified ${classified.length} entries.`);

  // Persist concept candidates — merge with existing file
  const conceptCandidatesPath = join(vault.warmDir, "_concept-candidates.json");
  let existingConcepts: Record<string, { count: number; sources: string[]; firstSeen: string }> = {};
  try {
    const raw = await readFile(conceptCandidatesPath, "utf-8");
    existingConcepts = JSON.parse(raw);
  } catch { /* fresh file */ }
  for (const [term, data] of Object.entries(conceptCandidates)) {
    if (existingConcepts[term]) {
      existingConcepts[term].count += data.count;
      existingConcepts[term].sources = [...new Set([...existingConcepts[term].sources, ...data.sources])];
    } else {
      existingConcepts[term] = data;
    }
  }
  await writeFile(conceptCandidatesPath, JSON.stringify(existingConcepts, null, 2), "utf-8");

  // Persist orphan candidates — append to existing array
  if (orphanCandidates.length > 0) {
    const orphanPath = join(vault.warmDir, "_orphan-candidates.json");
    let existingOrphans: typeof orphanCandidates = [];
    try {
      const raw = await readFile(orphanPath, "utf-8");
      existingOrphans = JSON.parse(raw);
    } catch { /* fresh file */ }
    await writeFile(orphanPath, JSON.stringify([...existingOrphans, ...orphanCandidates], null, 2), "utf-8");
  }

  // Theme merge proposals → pending updates
  for (const proposal of themeMergeProposals) {
    const id = randomUUID();
    const pendingUpdate = {
      id,
      theme: proposal.proposed,
      proposedContent: `## Merge proposal\n\nProposed merge: [[${proposal.proposed}]] → [[${proposal.canonical}]]\nReason: ${proposal.reason}\n\nApproving this pending update will rewrite links and delete the source theme.`,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId: new Date().toISOString(),
      lintFix: "merge" as const,
      related: [proposal.canonical],
    };
    await writeFile(join(vault.pendingDir, `${id}.json`), JSON.stringify(pendingUpdate, null, 2), "utf-8");
  }

  let pending: Awaited<ReturnType<typeof synthesizeToPending>>;
  try {
    pending = await synthesizeToPending(vault, classified, provider, model, proposedTypes);
  } catch (err) {
    console.error("[dream] Synthesis failed — hot files preserved for retry:", err);
    await vaultLog("error", "Synthesis failed, hot files NOT archived", String(err));
    throw err;
  }
  console.error(`[dream] Created ${pending.length} pending update(s). Review in the Control Center.`);

  await generateIndex(vault);
  const backlinks = await buildBacklinks(vault);
  await writeBacklinksFile(vault, backlinks);
  const themeNames = pending.map((p) => p.theme).join(", ");
  await appendLog(vault, "dream", `${entries.length} entries → ${pending.length} updates (${themeNames})`);

  await archiveProcessedHotFiles(vault);
  await vaultLog("info", "Dream pipeline complete", `${classified.length} entries → ${pending.length} pending update(s)`);
  console.error("[dream] Hot files archived. Dream complete.");
}

async function readHotEntries(vault: Vault): Promise<ActivityEntry[]> {
  const files = await readdir(vault.hotDir);
  const entries: ActivityEntry[] = [];

  for (const file of files) {
    if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
    const content = await readFile(join(vault.hotDir, file), "utf-8");
    entries.push(...parseActivityBlocks(content));
  }

  const ingestDir = join(vault.hotDir, "ingest");
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

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function generateIndex(vault: Vault): Promise<void> {
  const files = await readdir(vault.warmDir);
  const themeFiles = files.filter(
    (f) => f.endsWith(".md") && f !== "index.md" && f !== "log.md" && !f.startsWith("_")
  );

  const themeDocs = await Promise.all(themeFiles.map(async (file) => {
    const name = file.replace(/\.md$/, "");
    const doc = await readTheme(vault, name);
    if (!doc) return null;

    const type = doc.type ?? "project";

    // Extract a summary from the first content section heading
    const lines = doc.content.split("\n");
    const sectionHeadings = ["## Current Status", "## Definition", "## Summary"];
    let summary = "";
    for (const heading of sectionHeadings) {
      const idx = lines.findIndex((l) => l.trim() === heading);
      if (idx === -1) continue;
      for (let i = idx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t && !t.startsWith("#")) {
          summary = t.length > 100 ? t.slice(0, 100) : t;
          break;
        }
      }
      if (summary) break;
    }

    // Auto-infer dormancy for projects that haven't been updated in >30d and
    // don't have a status already set. Keeps the index honest without waiting
    // for a lint pass/approval cycle. Defensively ignores malformed lastUpdated
    // values so a bad frontmatter date can never flip everything to dormant.
    let status = doc.status;
    if (type === "project" && !status) {
      const parsed = Date.parse(doc.lastUpdated);
      if (Number.isFinite(parsed)) {
        const ageDays = (Date.now() - parsed) / 86_400_000;
        if (ageDays > 30) status = "dormant";
      }
    }

    return {
      name,
      type,
      summary,
      lastUpdated: doc.lastUpdated,
      status,
      statusReason: doc.statusReason,
    };
  }));

  const valid = themeDocs.filter((t): t is NonNullable<typeof themeDocs[0]> => t !== null);

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    } catch {
      return iso;
    }
  };

  // Group by type, sorted by lastUpdated descending within each group
  const byType: Record<string, typeof valid> = {
    project: [],
    concept: [],
    entity: [],
    "source-summary": [],
  };
  for (const t of valid) {
    const bucket = byType[t.type] ?? byType["project"];
    bucket.push(t);
  }
  for (const list of Object.values(byType)) {
    list.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  }

  // Read stub candidates from _lint.md if recent (< 8 days)
  let stubsSection = "";
  try {
    const lintContent = await readFile(join(vault.warmDir, "_lint.md"), "utf-8");
    const dateMatch = lintContent.match(/# Wiki Lint — (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const lintAge = (Date.now() - new Date(dateMatch[1]).getTime()) / 86_400_000;
      if (lintAge < 8) {
        const stubMatch = lintContent.match(/## Stub candidates[\s\S]*?(?=\n## |\n---|\n# |$)/);
        if (stubMatch) {
          const stubLines = stubMatch[0].split("\n").filter((l) => l.startsWith("- "));
          if (stubLines.length > 0) {
            stubsSection = `\n## Stubs\nMentioned but not yet written:\n${stubLines.slice(0, 5).join("\n")}\n`;
          }
        }
      }
    }
  } catch { /* _lint.md may not exist yet */ }

  const SECTION_LABELS: Record<string, string> = {
    project: "## Projects",
    concept: "## Concepts",
    entity: "## Entities",
    "source-summary": "## Sources",
  };

  // Render priority: things needing attention (blocked, paused) first, then
  // active (and untagged, which we render as "active"), then things the user
  // has explicitly moved out of play (complete/dormant). Typing `match` against
  // ProjectStatus | undefined means adding a new lifecycle value will trigger a
  // compile error here if it isn't covered.
  type StatusGroup = { status: ProjectStatus; label: string; includeUntagged?: boolean };
  const PROJECT_GROUP_ORDER: StatusGroup[] = [
    { status: "blocked",  label: "### Blocked" },
    { status: "paused",   label: "### Paused" },
    { status: "active",   label: "### Active", includeUntagged: true },
    { status: "complete", label: "### Complete" },
    { status: "dormant",  label: "### Dormant (>30d idle)" },
  ];
  const matchesGroup = (s: ProjectStatus | undefined, g: StatusGroup): boolean =>
    s === g.status || (!s && !!g.includeUntagged);

  const sections: string[] = [];
  for (const [type, items] of Object.entries(byType)) {
    if (items.length === 0) continue;
    sections.push(SECTION_LABELS[type]);

    if (type === "project") {
      for (const group of PROJECT_GROUP_ORDER) {
        const matching = items.filter((t) => matchesGroup(t.status, group));
        if (matching.length === 0) continue;
        sections.push(group.label);
        for (const t of matching) {
          const datePart = t.lastUpdated ? ` (${formatDate(t.lastUpdated)})` : "";
          const summaryPart = t.summary ? ` — ${t.summary}` : "";
          const reasonPart = t.statusReason ? ` _(${t.statusReason})_` : "";
          sections.push(`- [[${t.name}]]${summaryPart}${datePart}${reasonPart}`);
        }
        sections.push("");
      }
    } else {
      for (const t of items) {
        const datePart = t.lastUpdated ? ` (${formatDate(t.lastUpdated)})` : "";
        const summaryPart = t.summary ? ` — ${t.summary}` : "";
        sections.push(`- [[${t.name}]]${summaryPart}${datePart}`);
      }
      sections.push("");
    }
  }

  const now = new Date().toISOString();
  const total = valid.length;
  const indexContent = `# OpenPulse Knowledge Base\n\n${sections.join("\n")}${stubsSection}\nLast updated: ${now} | ${total} themes\n`;
  await writeFile(join(vault.warmDir, "index.md"), indexContent, "utf-8");
}

export async function appendLog(vault: Vault, type: string, detail: string): Promise<void> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const line = `## [${timestamp}] ${type} | ${detail}\n`;
  await appendFile(join(vault.warmDir, "log.md"), line, "utf-8");
}

main().catch((error) => {
  console.error("[dream] Fatal error:", error);
  process.exit(1);
});
