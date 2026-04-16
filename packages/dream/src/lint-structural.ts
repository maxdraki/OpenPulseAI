import { readFile } from "node:fs/promises";
import type { Vault } from "@openpulse/core";
import { listThemes, readTheme } from "@openpulse/core";
import { buildBacklinks } from "./backlinks.js";

/**
 * Structural issue found in a theme file.
 */
export interface StructuralIssue {
  type: "broken-link" | "orphan" | "schema-noncompliant" | "stale" | "duplicate-date";
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
  }

  return issues;
}

/**
 * Check 1: Find all [[ref]] links that don't exist in the theme set.
 */
function checkBrokenLinks(content: string, themeSet: Set<string>): Set<string> {
  const brokenLinks = new Set<string>();
  const linkRegex = /\[\[([^\]]+)\]\]/g;

  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const target = match[1];
    if (!themeSet.has(target)) {
      brokenLinks.add(target);
    }
  }

  return brokenLinks;
}

/**
 * Check 2: Is a theme orphaned?
 * A theme is an orphan if it has no inbound links AND no outbound links (excluding self-links).
 */
function checkOrphan(theme: string, content: string, backlinks: Map<string, string[]>): boolean {
  // Check inbound links
  const inboundLinks = backlinks.get(theme) || [];
  if (inboundLinks.length > 0) {
    return false; // has inbound links, not an orphan
  }

  // Check outbound links (excluding self-links)
  const links = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]).filter(t => t !== theme);
  if (links.length > 0) {
    return false; // has outbound links, not an orphan
  }

  // No inbound, no outbound
  return true;
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
  const dateRegex = /^###\s+(\d{4}-\d{2}-\d{2})\b/gm;
  const seenDates = new Set<string>();

  let match;
  while ((match = dateRegex.exec(content)) !== null) {
    const dateString = match[1];
    if (seenDates.has(dateString)) {
      return {
        type: "duplicate-date",
        theme,
        detail: `Duplicate dated section: ### ${dateString}`,
      };
    }
    seenDates.add(dateString);
  }

  return null;
}
