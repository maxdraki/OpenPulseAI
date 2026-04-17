import { readFile } from "node:fs/promises";
import type { Vault } from "@openpulse/core";
import { listThemes, readTheme } from "@openpulse/core";
import { buildBacklinks } from "./backlinks.js";
import { findFuzzyMatches } from "./canonicalize.js";

/**
 * Structural issue found in a theme file.
 */
export interface StructuralIssue {
  type:
    | "broken-link"
    | "orphan"
    | "schema-noncompliant"
    | "stale"
    | "duplicate-date"
    | "low-value"
    | "duplicate-theme"
    | "low-provenance";
  theme: string;   // the theme with the issue
  detail: string;  // human-readable description
  target?: string; // for broken-link: the missing link target
}

/** Number of days before a theme is considered stale */
const STALE_DAYS = 90;

/** Required fields in theme frontmatter */
const REQUIRED_FRONTMATTER = ["lastUpdated"];

/**
 * Run structural checks on all theme files in the vault.
 *
 * Checks:
 * 1. Broken links — [[ref]] where ref is not a known theme
 * 2. Orphans — themes with no inbound links and no outbound links
 * 3. Schema compliance — required frontmatter fields present
 * 4. Stale — no activity for > STALE_DAYS
 * 5. Duplicate dated sections — same ### YYYY-MM-DD heading appears twice
 */
export async function runStructuralChecks(vault: Vault): Promise<StructuralIssue[]> {
  const issues: StructuralIssue[] = [];

  const themeNames = await listThemes(vault);
  const themeSet = new Set(themeNames);
  const backlinks = await buildBacklinks(vault);

  for (const theme of themeNames) {
    const doc = await readTheme(vault, theme);
    if (!doc) {
      continue;
    }

    // Check 1: Broken links
    const brokenLinks = checkBrokenLinks(doc.content, themeSet);
    for (const target of brokenLinks) {
      issues.push({
        type: "broken-link",
        theme,
        detail: `Contains broken link to [[${target}]]`,
        target,
      });
    }

    // Check 2: Orphan (only if more than 1 theme exists)
    if (themeNames.length > 1) {
      const isOrphan = checkOrphan(theme, doc.content, backlinks);
      if (isOrphan) {
        issues.push({
          type: "orphan",
          theme,
          detail: "No inbound links and no outbound links",
        });
      }
    }

    // Check 3: Schema compliance
    const schemaIssue = await checkSchemaCompliance(vault, theme);
    if (schemaIssue) {
      issues.push(schemaIssue);
    }

    // Check 4: Stale
    const staleIssue = checkStale(theme, doc.lastUpdated);
    if (staleIssue) {
      issues.push(staleIssue);
    }

    // Check 5: Duplicate dated sections
    const duplicateDateIssue = checkDuplicateDates(theme, doc.content);
    if (duplicateDateIssue) {
      issues.push(duplicateDateIssue);
    }

    // Check 6: Low-value page
    const lowValueIssue = checkLowValue(theme, doc.content);
    if (lowValueIssue) issues.push(lowValueIssue);

    // Check 8: Low provenance
    const lowProv = checkLowProvenance(theme, doc.content);
    if (lowProv) issues.push(lowProv);
  }

  // Check 7: Duplicate themes (pair-wise, done outside per-theme loop)
  issues.push(...checkDuplicateThemes(themeNames));

  return issues;
}

/**
 * Check 1: Find all [[ref]] links that don't exist in the theme set.
 */
function checkBrokenLinks(content: string, themeSet: Set<string>): Set<string> {
  const brokenLinks = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (!themeSet.has(match[1])) brokenLinks.add(match[1]);
  }
  return brokenLinks;
}

/**
 * Check 2: Is a theme orphaned?
 * A theme is an orphan if it has no inbound links AND no outbound links (excluding self-links).
 */
function checkOrphan(theme: string, content: string, backlinks: Map<string, string[]>): boolean {
  const inbound = backlinks.get(theme) ?? [];
  if (inbound.length > 0) return false;

  const outbound = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].some((m) => m[1] !== theme);
  return !outbound;
}

/**
 * Check 3: Does the theme file have all required frontmatter fields?
 */
async function checkSchemaCompliance(vault: Vault, theme: string): Promise<StructuralIssue | null> {
  try {
    const filePath = vault.themeFilePath(theme);
    const content = await readFile(filePath, "utf-8");

    // Check for each required field in frontmatter
    for (const field of REQUIRED_FRONTMATTER) {
      const fieldRegex = new RegExp(`^${field}:`, "m");
      if (!fieldRegex.test(content)) {
        return {
          type: "schema-noncompliant",
          theme,
          detail: `Missing required frontmatter field: ${field}`,
        };
      }
    }

    return null;
  } catch (err) {
    // If the file can't be read, report a schema issue
    return {
      type: "schema-noncompliant",
      theme,
      detail: `Could not read theme file: ${String(err).slice(0, 60)}`,
    };
  }
}

/**
 * Check 4: Is the theme stale?
 */
function checkStale(theme: string, lastUpdated: string): StructuralIssue | null {
  try {
    const lastUpdatedDate = new Date(lastUpdated);
    const daysSince = (Date.now() - lastUpdatedDate.getTime()) / 86_400_000;

    if (daysSince > STALE_DAYS) {
      const shortDate = lastUpdated.slice(0, 10); // YYYY-MM-DD
      return {
        type: "stale",
        theme,
        detail: `No activity for ${Math.floor(daysSince)} days (last updated: ${shortDate})`,
      };
    }

    return null;
  } catch {
    // Invalid date format — not necessarily an issue
    return null;
  }
}

/**
 * Check 5: Are there duplicate ### YYYY-MM-DD headings?
 */
function checkDuplicateDates(theme: string, content: string): StructuralIssue | null {
  const seenDates = new Set<string>();
  for (const match of content.matchAll(/^###\s+(\d{4}-\d{2}-\d{2})\b/gm)) {
    if (seenDates.has(match[1])) {
      return { type: "duplicate-date", theme, detail: `Duplicate dated section: ### ${match[1]}` };
    }
    seenDates.add(match[1]);
  }
  return null;
}

/**
 * Check 6: Low-value page.
 * Flags a theme when content is too short, or when all provenance markers
 * refer to a single source AND the page has only a handful of bullets.
 */
function checkLowValue(theme: string, content: string): StructuralIssue | null {
  if (content.length < 250) {
    return { type: "low-value", theme, detail: `Content is only ${content.length} chars (< 250)` };
  }
  const srcMatches = [...content.matchAll(/\^\[src:([^\]]+)\]/g)].map((m) => m[1]);
  const uniqueSources = new Set(srcMatches);
  const bulletCount = content.split("\n").filter((l) => /^[-*]\s/.test(l.trim())).length;
  if (srcMatches.length > 0 && uniqueSources.size === 1 && bulletCount <= 3) {
    return {
      type: "low-value",
      theme,
      detail: `All ${srcMatches.length} citations point to a single source "${[...uniqueSources][0]}" and only ${bulletCount} bullets`,
    };
  }
  return null;
}

/**
 * Check 7: Duplicate-theme detection (pair-wise).
 * Uses `findFuzzyMatches` to locate near-duplicate theme names
 * (Levenshtein ≤ 2 or shared-prefix ≥ 6).
 */
function checkDuplicateThemes(themeNames: string[]): StructuralIssue[] {
  const pairs = findFuzzyMatches(themeNames);
  return pairs.map(({ a, b, reason }) => ({
    type: "duplicate-theme" as const,
    theme: a,
    detail: `Near-duplicate of [[${b}]] (${reason})`,
    target: b,
  }));
}

/**
 * Check 8: Low-provenance.
 * Flags a theme when fewer than 70% of body paragraphs carry a `^[src:...]`
 * marker. Headings and bullets are excluded.
 */
function checkLowProvenance(theme: string, content: string): StructuralIssue | null {
  const paragraphs = content.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    return t && !t.startsWith("#") && !/^[-*]\s/.test(t);
  });
  if (paragraphs.length === 0) return null;
  const withProv = paragraphs.filter((p) => /\^\[src:/.test(p)).length;
  const coverage = withProv / paragraphs.length;
  if (coverage < 0.7) {
    return {
      type: "low-provenance",
      theme,
      detail: `${withProv} of ${paragraphs.length} paragraphs have provenance (${Math.round(coverage * 100)}%)`,
    };
  }
  return null;
}
