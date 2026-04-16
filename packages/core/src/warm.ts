import { readFile, writeFile, readdir } from "node:fs/promises";
import type { Vault } from "./vault.js";
import type { ThemeDocument, ThemeType } from "./types.js";

const VALID_THEME_TYPES = new Set<string>(["project", "concept", "entity", "source-summary"]);

export async function writeTheme(
  vault: Vault,
  theme: string,
  content: string,
  meta?: {
    type?: ThemeType;
    sources?: string[];
    related?: string[];
    created?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const fmLines = [
    "---",
    `theme: ${theme}`,
    `lastUpdated: ${now}`,
  ];
  if (meta?.type) fmLines.push(`type: ${meta.type}`);
  if (meta?.created) fmLines.push(`created: ${meta.created}`);
  if (meta?.sources?.length) fmLines.push(`sources: [${meta.sources.join(", ")}]`);
  if (meta?.related?.length) fmLines.push(`related: [${meta.related.join(", ")}]`);
  fmLines.push("---", "", content, "");
  await writeFile(vault.themeFilePath(theme), fmLines.join("\n"), "utf-8");
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

function parseThemeFile(
  theme: string,
  path: string,
  raw: string
): ThemeDocument {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  let lastUpdated = new Date().toISOString();
  let type: ThemeType | undefined;
  let sources: string[] | undefined;
  let related: string[] | undefined;
  let created: string | undefined;

  if (fmMatch) {
    const fm = fmMatch[1];
    const lu = fm.match(/lastUpdated:\s*(.+)/);
    if (lu) lastUpdated = lu[1].trim();
    const t = fm.match(/type:\s*(.+)/);
    const tVal = t?.[1].trim();
    if (tVal && VALID_THEME_TYPES.has(tVal)) type = tVal as ThemeType;
    const c = fm.match(/created:\s*(.+)/);
    if (c) created = c[1].trim();
    const src = fm.match(/sources:\s*\[([^\]]*)\]/);
    if (src) sources = src[1].split(",").map(s => s.trim()).filter(Boolean);
    const rel = fm.match(/related:\s*\[([^\]]*)\]/);
    if (rel) related = rel[1].split(",").map(s => s.trim()).filter(Boolean);
  }

  const content = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();
  return { theme, path, content, lastUpdated, type, sources, related, created };
}
