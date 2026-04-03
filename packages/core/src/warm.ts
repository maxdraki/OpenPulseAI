import { readFile, writeFile, readdir } from "node:fs/promises";
import type { Vault } from "./vault.js";
import type { ThemeDocument } from "./types.js";

export async function writeTheme(
  vault: Vault,
  theme: string,
  content: string
): Promise<void> {
  const now = new Date().toISOString();
  const md = [
    "---",
    `theme: ${theme}`,
    `lastUpdated: ${now}`,
    "---",
    "",
    content,
    "",
  ].join("\n");

  await writeFile(vault.themeFilePath(theme), md, "utf-8");
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
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
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

  if (fmMatch) {
    const luMatch = fmMatch[1].match(/lastUpdated:\s*(.+)/);
    if (luMatch) lastUpdated = luMatch[1].trim();
  }

  const content = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw.trim();

  return { theme, path, content, lastUpdated };
}
