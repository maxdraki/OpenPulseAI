import type { ActivityEntry, ClassificationResult, LlmProvider, ThemeType } from "@openpulse/core";
import { canonicalizeThemes } from "./canonicalize.js";

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
  // State/status words (frequently misclassified)
  "closed", "open", "merged", "done", "new", "all", "recent", "latest",
  "current", "active", "updated", "other", "main", "last", "next", "old",
  "none", "true", "false",
]);

/** A valid theme name is at least 3 chars and not a common stopword. */
function isValidThemeName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return lower.length >= 3 && !THEME_STOPWORDS.has(lower);
}

const ABSENCE_LINE =
  /no\s+(recent\s+|file\s+|pr\s+|commit\s+|modification\s+)?activity\b|no\s+commits?\b|no\s+pr\s+activity\b|no\s+(file\s+)?modifications?\b|no\s+repos?\s+configured\b|no\s+.{1,50}\s+since\s+last\s+run\b|no\s+.{1,30}\s+detected\b|no\s+changes?\b|inactive\b|nothing\s+(happened|to\s+report)\b/i;
const HEADING_RE = /^#{1,4}\s+/;
const LABEL_ONLY_RE = /^[-*]\s*\*\*[^*]+\*\*:\s*$/;
const EMPTY_BULLET_RE = /^[-*]\s*$/;

function isSubstantive(log: string): boolean {
  return log.split("\n").some((line) => {
    const t = line.trim();
    if (!t || t.length < 5) return false;
    if (t.startsWith("#")) return false;
    if (LABEL_ONLY_RE.test(t)) return false;
    if (EMPTY_BULLET_RE.test(t)) return false;
    return true;
  });
}

function stripOrphanedHeadings(log: string): string {
  const lines = log.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING_RE.test(lines[i])) {
      result.push(lines[i]);
      continue;
    }
    let hasContent = false;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (HEADING_RE.test(t)) break;
      if (t.length > 4 && !LABEL_ONLY_RE.test(t) && !EMPTY_BULLET_RE.test(t)) {
        hasContent = true;
        break;
      }
    }
    if (hasContent) result.push(lines[i]);
  }
  return result.join("\n");
}

/**
 * Pre-filter: remove "no activity" / "inactive" noise from entries.
 * Returns cleaned entries — strips paragraphs about inactive projects.
 */
function preFilter(entries: ActivityEntry[]): ActivityEntry[] {
  return entries
    .map((entry) => {
      const lines = entry.log.split("\n");
      const filtered = lines.filter((line) => {
        const lower = line.toLowerCase();
        if (ABSENCE_LINE.test(lower) &&
            !/(modified|changed|added|created|updated|committed|pushed|merged)/i.test(lower)) {
          return false;
        }
        return true;
      });

      const withoutOrphans = stripOrphanedHeadings(filtered.join("\n")).trim();
      if (!withoutOrphans || !isSubstantive(withoutOrphans)) return null;

      // Entry-level drop: if we have fewer than 5 substantive lines and no activity tokens, it's noise.
      const substantiveCount = withoutOrphans.split("\n").filter((line) => {
        const t = line.trim();
        if (!t || t.length < 5) return false;
        if (t.startsWith("#")) return false;
        if (LABEL_ONLY_RE.test(t)) return false;
        if (EMPTY_BULLET_RE.test(t)) return false;
        return true;
      }).length;
      const ACTIVITY_TOKEN_RE = /(modified|changed|added|created|updated|committed|pushed|merged|commit|PR |pull|issue|#\d+)/i;
      if (substantiveCount < 5 && !ACTIVITY_TOKEN_RE.test(withoutOrphans)) {
        return null;
      }

      return { ...entry, log: withoutOrphans };
    })
    .filter((e): e is ActivityEntry => e !== null);
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

  // 2a. "### owner/repo" heading format (github-activity multi-repo output)
  if (tags.length === 0) {
    const headingRepoMatch = log.match(/^###\s+[a-zA-Z0-9_.-]+\/([a-zA-Z0-9_.-]+)\s*$/m);
    if (headingRepoMatch) {
      const name = headingRepoMatch[1].toLowerCase();
      if (isValidThemeName(name)) tags.push(name);
    }
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

/** Return value of classifyEntries — includes proposed page types for new themes. */
export interface ClassifyResult {
  classified: ClassificationResult[];
  proposedTypes: Record<string, ThemeType>;
  conceptCandidates: Record<string, { count: number; sources: string[]; firstSeen: string }>;
  orphanCandidates: Array<{
    entryTimestamp: string;
    source?: string;
    log: string;
    proposedThemes: string[];
    confidence: number;
    deferredAt: string;
  }>;
  themeMergeProposals: Array<{
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}

/**
 * Infer a page type for a theme based on the entry that introduced it.
 * Only used for themes that don't already exist in the vault.
 */
function inferType(entry: ActivityEntry): ThemeType {
  // Ingested documents become source-summary pages
  if (entry.theme === "ingested") return "source-summary";
  // Default: project
  return "project";
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
): Promise<ClassifyResult> {
  // Step 1: Pre-filter noise
  const cleaned = preFilter(entries);

  const results: ClassificationResult[] = [];
  const proposedTypes: Record<string, ThemeType> = {};
  const conceptCandidatesMap: Record<string, { count: number; sources: string[]; firstSeen: string }> = {};
  const orphanCandidatesList: ClassifyResult["orphanCandidates"] = [];
  const ORPHAN_CONF_THRESHOLD = 0.5;
  const nowIso = new Date().toISOString();
  const existingThemeSet = new Set(existingThemes);
  const needsLlm: ActivityEntry[] = [];

  for (const entry of cleaned) {
    // Step 2: Already tagged
    if (entry.theme && entry.theme !== "auto" && entry.theme !== "ingested") {
      results.push({ entry, themes: [entry.theme], confidence: 1.0 });
      if (!existingThemeSet.has(entry.theme)) {
        proposedTypes[entry.theme] = inferType(entry);
      }
      continue;
    }

    // Handle ingested entries
    if (entry.theme === "ingested") {
      if (!existingThemeSet.has("ingested")) {
        proposedTypes["ingested"] = "source-summary";
      }
    }

    // Step 3: Deterministic classification
    const tags = deterministicClassify(entry, existingThemes);
    if (tags) {
      results.push({ entry, themes: tags, confidence: 0.95 });
      for (const theme of tags) {
        if (!existingThemeSet.has(theme)) proposedTypes[theme] = inferType(entry);
      }
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
- Do NOT use state or status words as themes (avoid "closed", "open", "merged", "done", "new", "updated", "active", "latest")
- Reuse existing themes when relevant rather than creating new ones
- Never use common English words (e.g. "or", "and", "the", "in")
- Theme names must be at least 3 characters and meaningful on their own as a wiki page title
- For each theme, also provide a type: "project" (default), "concept", "entity", or "source-summary"

Entries:
${entriesText}

For each entry also identify 0-3 "concept_candidates" — terms, patterns, or entities
that appear prominently in the entry and might deserve their own wiki page (e.g.
"barrier-pattern", "wiki-maturity"). These are suggestions, not themes.

Respond with ONLY a JSON array:
[{"index": 0, "themes": ["name1"], "type": "project", "concept_candidates": ["term-a", "term-b"]}]`,
        temperature: 0,
      });

      // Strip markdown fences that LLMs sometimes add
      let jsonText = responseText.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      const parsed = JSON.parse(jsonText) as Array<{
        index: number;
        themes: string[];
        type?: string;
        concept_candidates?: string[];
      }>;
      const returnedIndexes = new Set<number>();
      for (const p of parsed) {
        if (p.index >= 0 && p.index < needsLlm.length) {
          const validThemes = p.themes.filter(isValidThemeName).slice(0, 3);
          const themes = validThemes.length > 0 ? validThemes : [needsLlm[p.index].source ?? "uncategorized"];
          const inferredType = (["project", "concept", "entity", "source-summary"].includes(p.type ?? ""))
            ? (p.type as ThemeType)
            : "project";
          const llmConfidence = 0.7;

          // If confidence is low AND all themes are new (no match to existing), route to orphan candidates
          const anyExisting = themes.some((t) => existingThemeSet.has(t));
          if (!anyExisting && llmConfidence < ORPHAN_CONF_THRESHOLD) {
            orphanCandidatesList.push({
              entryTimestamp: needsLlm[p.index].timestamp,
              source: needsLlm[p.index].source,
              log: needsLlm[p.index].log,
              proposedThemes: themes,
              confidence: llmConfidence,
              deferredAt: new Date().toISOString(),
            });
            returnedIndexes.add(p.index);
          } else {
            results.push({ entry: needsLlm[p.index], themes, confidence: llmConfidence });
            returnedIndexes.add(p.index);
            for (const theme of themes) {
              if (!existingThemeSet.has(theme)) {
                proposedTypes[theme] = inferredType;
              }
            }
          }

          // Accumulate concept candidates suggested by the LLM (regardless of routing)
          if (Array.isArray(p.concept_candidates)) {
            for (const raw of p.concept_candidates) {
              const term = String(raw).trim();
              if (!term || !isValidThemeName(term)) continue;
              const source = needsLlm[p.index].source ?? "unknown";
              const existing = conceptCandidatesMap[term];
              if (existing) {
                existing.count += 1;
                if (!existing.sources.includes(source)) existing.sources.push(source);
              } else {
                conceptCandidatesMap[term] = { count: 1, sources: [source], firstSeen: nowIso };
              }
            }
          }
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

  // Canonicalization: collect all theme names in classified results, redirect to existing canonical names
  const allProposed = [...new Set(results.flatMap((r) => r.themes))];
  const canonicalization = await canonicalizeThemes(allProposed, existingThemes, provider, model);

  // Apply redirects (silent merges): rewrite theme names in classified results
  for (const r of results) {
    r.themes = r.themes.map((t) => canonicalization.redirects[t] ?? t);
  }

  // Apply redirects to proposedTypes: move type info from source → canonical, delete source key
  for (const [from, to] of Object.entries(canonicalization.redirects)) {
    if (proposedTypes[from] && !proposedTypes[to]) {
      proposedTypes[to] = proposedTypes[from];
    }
    delete proposedTypes[from];
  }

  return {
    classified: results,
    proposedTypes,
    conceptCandidates: conceptCandidatesMap,
    orphanCandidates: orphanCandidatesList,
    themeMergeProposals: canonicalization.proposals,
  };
}
