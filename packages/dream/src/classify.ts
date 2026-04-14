import type { ActivityEntry, ClassificationResult, LlmProvider } from "@openpulse/core";

/**
 * Common English words that should never become theme names.
 * Themes must be meaningful project/entity/concept names, not conjunctions,
 * articles, prepositions, or other glue words.
 */
const THEME_STOPWORDS = new Set([
  // Articles
  "a", "an", "the",
  // Conjunctions
  "and", "or", "but", "nor", "for", "yet", "so",
  // Prepositions
  "in", "on", "at", "to", "by", "of", "up", "as", "via", "per", "vs",
  // Common short words that are never project names
  "is", "it", "be", "do", "go", "no", "if", "we", "my",
]);

/** A valid theme name is at least 3 chars and not a common stopword. */
function isValidThemeName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return lower.length >= 3 && !THEME_STOPWORDS.has(lower);
}

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
 * Returns an array of 1-3 theme tags.
 * - Primary tag from file paths / repo refs / headings
 * - Secondary tags: scan entry text for mentions of existing theme names
 */
function deterministicClassify(entry: ActivityEntry, existingThemes: string[]): string[] | null {
  const log = entry.log;
  const tags: string[] = [];

  // 1. File paths: /Users/.../Documents/GitHub/PROJECT_NAME/...
  const pathMatch = log.match(/\/(?:Documents\/GitHub|Projects|repos|src)\/([a-zA-Z0-9_-]+)\//);
  if (pathMatch) {
    const name = pathMatch[1].toLowerCase();
    if (isValidThemeName(name)) tags.push(name);
  }

  // 2. GitHub repo references: owner/repo — match any owner.
  // Require the captured repo name to be a valid theme (filters out "and/or" → "or" false positives).
  if (tags.length === 0) {
    const repoMatch = log.match(/\b[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)\b(?=.*(?:commit|push|PR|pull|merge|release))/i)
      ?? log.match(/\*?\*?Repository:?\*?\*?\s*`?[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)`?/i);
    if (repoMatch) {
      const name = repoMatch[1].toLowerCase();
      if (isValidThemeName(name)) tags.push(name);
    }
  }

  // 3. Source metadata — if the entry came from a known source, use it
  if (tags.length === 0 && entry.source && entry.source !== "auto") {
    const projectMention = log.match(/^###?\s+([A-Za-z0-9_-]+)\s*$/m);
    if (projectMention) {
      const name = projectMention[1].toLowerCase();
      const headingStopwords = ["instructions", "output", "summary", "status", "highlights", "findings", "context"];
      if (!headingStopwords.includes(name) && isValidThemeName(name)) {
        tags.push(name);
      }
    }
  }

  // No primary tag found — return null to trigger LLM
  if (tags.length === 0) return null;

  // Secondary tags: scan for existing theme name mentions.
  // Require the theme to appear as a whole word NOT adjacent to a slash,
  // so "or" in "and/or" doesn't match the theme "or".
  for (const theme of existingThemes) {
    if (tags.includes(theme)) continue;
    if (!isValidThemeName(theme)) continue;
    const escaped = theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![/\\w])${escaped}(?![/\\w])`, "i");
    if (re.test(log)) {
      tags.push(theme);
    }
    if (tags.length >= 3) break;
  }

  return tags.slice(0, 3);
}

/**
 * Classify entries into themes.
 *
 * Pipeline:
 * 1. Pre-filter: strip "inactive/no changes" noise
 * 2. Already-tagged entries: use their existing theme
 * 3. Deterministic: extract project from file paths, repo names + secondary tags from existingThemes
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
      results.push({ entry, themes: [entry.theme], confidence: 1.0 });
      continue;
    }

    // Step 3: Deterministic classification
    const tags = deterministicClassify(entry, existingThemes);
    if (tags) {
      results.push({ entry, themes: tags, confidence: 0.95 });
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
        prompt: `Classify each numbered entry into 1-2 themes (lowercase-kebab-case).
Existing themes: ${existingThemes.length > 0 ? existingThemes.join(", ") : "(none)"}.
Rules:
- Prefer 1 theme. Only use 2 if the entry genuinely covers two distinct projects or topics.
- Use specific project or product names as themes (e.g. "vdp", "data-pipeline", "openpulse")
- Do NOT use collector or tool names as themes (e.g. avoid "jira", "github", "slack" — use the project name instead)
- Reuse existing themes when relevant rather than creating new ones
- Never use common English words (e.g. "or", "and", "the", "in", "new", "all")
- Theme names must be at least 3 characters and meaningful on their own as a wiki page title

Entries:
${entriesText}

Respond with ONLY a JSON array: [{"index": 0, "themes": ["name1"]}]`,
        temperature: 0,
      });

      // Strip markdown fences that LLMs sometimes add
      let jsonText = responseText.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      const parsed = JSON.parse(jsonText) as Array<{ index: number; themes: string[] }>;
      const returnedIndexes = new Set<number>();
      for (const p of parsed) {
        if (p.index >= 0 && p.index < needsLlm.length) {
          const validThemes = p.themes.filter(isValidThemeName).slice(0, 3);
          const themes = validThemes.length > 0 ? validThemes : [needsLlm[p.index].source ?? "uncategorized"];
          results.push({ entry: needsLlm[p.index], themes, confidence: 0.7 });
          returnedIndexes.add(p.index);
        }
      }

      // Handle entries the LLM omitted from its response
      for (let i = 0; i < needsLlm.length; i++) {
        if (!returnedIndexes.has(i)) {
          results.push({ entry: needsLlm[i], themes: [needsLlm[i].source ?? "uncategorized"], confidence: 0.3 });
        }
      }
    } catch (err) {
      console.error("[classify] LLM classification failed:", err);
      for (const entry of needsLlm) {
        results.push({
          entry,
          themes: [entry.source ?? "uncategorized"],
          confidence: 0.3,
        });
      }
    }
  }

  return results;
}
