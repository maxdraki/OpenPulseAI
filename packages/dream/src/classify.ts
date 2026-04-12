import type { ActivityEntry, ClassificationResult, LlmProvider } from "@openpulse/core";

/**
 * Pre-filter: remove "no activity" / "inactive" noise from entries.
 * Returns cleaned entries — strips paragraphs about inactive projects.
 */
function preFilter(entries: ActivityEntry[]): ActivityEntry[] {
  return entries
    .map((entry) => {
      // Strip lines/paragraphs about inactivity
      const lines = entry.log.split("\n");
      const filtered = lines.filter((line) => {
        const lower = line.toLowerCase();
        // Skip lines that only talk about inactivity
        if (/no (recent |file )?activity|inactive|no changes|no modifications|no .* detected/i.test(lower) &&
            !/(modified|changed|added|created|updated|committed|pushed|merged)/i.test(lower)) {
          return false;
        }
        return true;
      });

      const cleanedLog = filtered.join("\n").trim();
      if (!cleanedLog) return null;

      return { ...entry, log: cleanedLog };
    })
    .filter((e): e is ActivityEntry => e !== null && e.log.length > 10);
}

/**
 * Deterministic classification: extract project names from content.
 * Looks for file paths, repo references, and structured data.
 */
function deterministicClassify(entry: ActivityEntry): string | null {
  const log = entry.log;

  // 1. File paths: /Users/.../Documents/GitHub/PROJECT_NAME/...
  const pathMatch = log.match(/\/(?:Documents\/GitHub|Projects|repos|src)\/([a-zA-Z0-9_-]+)\//);
  if (pathMatch) return pathMatch[1].toLowerCase();

  // 2. GitHub repo references: owner/repo — match any owner
  const repoMatch = log.match(/\b[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\b(?=.*(?:commit|push|PR|pull|merge|release|issue))/i)
    ?? log.match(/\*?\*?Repository:?\*?\*?\s*`?[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)`?/i);
  if (repoMatch) return repoMatch[1].toLowerCase();

  // 3. Source metadata — if the entry came from a known source, use it
  if (entry.source && entry.source !== "auto") {
    // For skill-generated entries, check if the content mentions a specific project
    const projectMention = log.match(/^###?\s+([A-Za-z0-9_-]+)\s*$/m);
    if (projectMention) {
      const name = projectMention[1].toLowerCase();
      // Only use it if it looks like a project name (not a generic heading)
      if (!["instructions", "output", "summary", "status", "highlights", "findings", "context"].includes(name)) {
        return name;
      }
    }
  }

  return null;
}

/**
 * Classify entries into themes.
 *
 * Pipeline:
 * 1. Pre-filter: strip "inactive/no changes" noise
 * 2. Already-tagged entries: use their existing theme
 * 3. Deterministic: extract project from file paths, repo names
 * 4. LLM fallback: only for entries that can't be classified deterministically
 */
export async function classifyEntries(
  entries: ActivityEntry[],
  existingThemes: string[],
  provider: LlmProvider,
  model: string
): Promise<ClassificationResult[]> {
  // Step 1: Pre-filter noise
  const cleaned = preFilter(entries);

  const results: ClassificationResult[] = [];
  const needsLlm: ActivityEntry[] = [];

  for (const entry of cleaned) {
    // Step 2: Already tagged
    if (entry.theme && entry.theme !== "auto" && entry.theme !== "ingested") {
      results.push({ entry, theme: entry.theme, confidence: 1.0 });
      continue;
    }

    // Step 3: Deterministic classification
    const project = deterministicClassify(entry);
    if (project) {
      results.push({ entry, theme: project, confidence: 0.95 });
      continue;
    }

    // Step 4: Needs LLM
    needsLlm.push(entry);
  }

  // LLM fallback for remaining entries
  if (needsLlm.length > 0) {
    const entriesText = needsLlm
      .map((e, i) => `[${i}] ${e.timestamp}: ${e.log.slice(0, 300)}`)
      .join("\n\n");

    try {
      const responseText = await provider.complete({
        model,
        prompt: `Classify each numbered entry into a theme (lowercase-kebab-case).
Existing themes: ${existingThemes.length > 0 ? existingThemes.join(", ") : "(none)"}.
Use project names as themes when possible. Only create new themes for genuinely distinct topics.

Entries:
${entriesText}

Respond with ONLY a JSON array: [{"index": 0, "theme": "name"}]`,
        temperature: 0,
      });

      const parsed = JSON.parse(responseText) as Array<{ index: number; theme: string }>;
      for (const p of parsed) {
        if (p.index >= 0 && p.index < needsLlm.length) {
          results.push({ entry: needsLlm[p.index], theme: p.theme, confidence: 0.7 });
        }
      }
    } catch {
      // LLM failed — classify under source or "uncategorized"
      for (const entry of needsLlm) {
        results.push({
          entry,
          theme: entry.source ?? "uncategorized",
          confidence: 0.3,
        });
      }
    }
  }

  return results;
}
