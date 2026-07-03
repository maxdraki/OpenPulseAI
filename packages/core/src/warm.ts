import { readFile, writeFile, readdir } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Vault } from "./vault.js";
import type { ThemeDocument, ThemeType, ProjectStatus } from "./types.js";
import { PROJECT_STATUSES } from "./types.js";

const VALID_THEME_TYPES = new Set<string>(["project", "concept", "entity", "source-summary"]);
const VALID_PROJECT_STATUSES = new Set<ProjectStatus>(PROJECT_STATUSES);
const MAX_SKILLS_ON_THEME = 20;

export async function writeTheme(
  vault: Vault,
  theme: string,
  content: string,
  meta?: {
    type?: ThemeType;
    sources?: string[];
    related?: string[];
    created?: string;
    skills?: string[];
    status?: ProjectStatus;
    statusReason?: string;
  }
): Promise<void> {
  const frontmatter: Record<string, unknown> = {
    theme,
    lastUpdated: new Date().toISOString(),
  };
  if (meta?.type) frontmatter.type = meta.type;
  if (meta?.created) frontmatter.created = meta.created;
  if (meta?.sources?.length) frontmatter.sources = meta.sources;
  if (meta?.related?.length) frontmatter.related = meta.related;
  if (meta?.skills?.length) frontmatter.skills = meta.skills.slice(0, MAX_SKILLS_ON_THEME);
  if (meta?.status) frontmatter.status = meta.status;
  if (meta?.statusReason) frontmatter.statusReason = meta.statusReason;

  // defaultFlowStringType: "QUOTE_DOUBLE" ensures reasons with special chars
  // (colons, quotes, etc.) are always double-quoted — matches the existing
  // on-disk convention so diffs stay clean.
  const yamlBlock = stringifyYaml(frontmatter, {
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    singleQuote: false,
  });
  await writeFile(
    vault.themeFilePath(theme),
    `---\n${yamlBlock}---\n\n${content}\n`,
    "utf-8"
  );
}

export async function readTheme(
  vault: Vault,
  theme: string
): Promise<ThemeDocument | null> {
  try {
    const raw = await readFile(vault.themeFilePath(theme), "utf-8");
    return parseThemeFile(theme, vault.themeFilePath(theme), raw);
  } catch {
    return null;
  }
}

export async function listThemes(vault: Vault): Promise<string[]> {
  const entries = await readdir(vault.warmDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "index.md" && e.name !== "log.md" && !e.name.startsWith("_"))
    .map((e) => e.name.replace(/\.md$/, ""));
}

export async function readAllThemes(vault: Vault): Promise<ThemeDocument[]> {
  const themes = await listThemes(vault);
  const docs = await Promise.all(themes.map((t) => readTheme(vault, t)));
  return docs.filter((d): d is ThemeDocument => d !== null);
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" && x.trim().length > 0 ? x.trim() : undefined;
}

function asStringArray(x: unknown): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out = x.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * Splits a raw warm theme markdown file into its parsed YAML frontmatter
 * block (if any) and the body that follows. Shared by `parseThemeFile` and
 * the search chunker (`search/chunker.ts`) so there is exactly one place
 * that understands the on-disk frontmatter format.
 */
export function parseFrontmatterBlock(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { frontmatter: {}, body: raw.trim() };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fmMatch[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter — fall through with defaults, don't throw.
  }

  return { frontmatter, body: raw.slice(fmMatch[0].length).trim() };
}

function parseThemeFile(
  theme: string,
  path: string,
  raw: string
): ThemeDocument {
  const { frontmatter: fm, body: content } = parseFrontmatterBlock(raw);

  const lastUpdated = asString(fm.lastUpdated) ?? new Date().toISOString();
  let type: ThemeType | undefined;
  const typeVal = asString(fm.type);
  if (typeVal && VALID_THEME_TYPES.has(typeVal)) type = typeVal as ThemeType;
  const created = asString(fm.created);
  const sources = asStringArray(fm.sources);
  const related = asStringArray(fm.related);
  const skills = asStringArray(fm.skills);
  let status: ProjectStatus | undefined;
  const statusVal = asString(fm.status);
  if (statusVal && VALID_PROJECT_STATUSES.has(statusVal as ProjectStatus)) status = statusVal as ProjectStatus;
  const statusReason = asString(fm.statusReason);

  return { theme, path, content, lastUpdated, type, sources, related, created, skills, status, statusReason };
}
