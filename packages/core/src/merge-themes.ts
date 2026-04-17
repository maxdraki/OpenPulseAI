import { readFile, writeFile, unlink, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault.js";

/** Enforce safe theme names: alphanumerics, hyphens, underscores only; no path separators or ".." */
export function isSafeThemeName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.length > 100) return false;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return false;
  if (name === "." || name === ".." || name.includes("..")) return false;
  return true;
}

/**
 * Merge, rename, or delete a theme.
 *
 * Modes:
 *   - canonical=null: delete source.md and _facts/source.jsonl; rewrite all [[source]]
 *     references to plain `source` text (link removal).
 *   - canonical!=null, rename=false: rewrite [[source]] → [[canonical]] across warm files;
 *     append source content into canonical as a "### Merged from [[source]] on YYYY-MM-DD"
 *     section; merge _facts; delete source files.
 *   - canonical!=null, rename=true: rewrite [[source]] → [[canonical]]; move source content
 *     whole to canonical.md (no dated section); merge _facts; delete source files.
 *
 * Idempotent: each sub-step checks for state before acting.
 */
export async function mergeThemes(
  vault: Vault,
  source: string,
  canonical: string | null,
  opts: { rename?: boolean } = {}
): Promise<void> {
  if (!isSafeThemeName(source)) {
    throw new Error(`Unsafe source theme name: ${JSON.stringify(source)}`);
  }
  if (canonical !== null && !isSafeThemeName(canonical)) {
    throw new Error(`Unsafe canonical theme name: ${JSON.stringify(canonical)}`);
  }

  const warmDir = vault.warmDir;
  const factsDir = join(warmDir, "_facts");
  const srcPath = join(warmDir, `${source}.md`);
  const srcFactsPath = join(factsDir, `${source}.jsonl`);

  // Step 1: rewrite links in all other warm files
  await rewriteLinks(warmDir, source, canonical);

  // Step 2: content merge (only if canonical is non-null and source file exists)
  if (canonical !== null) {
    const canonPath = join(warmDir, `${canonical}.md`);
    const canonFactsPath = join(factsDir, `${canonical}.jsonl`);

    if (await fileExists(srcPath)) {
      const srcRaw = await readFile(srcPath, "utf-8");
      const srcBody = stripFrontmatter(srcRaw);
      const canonExists = await fileExists(canonPath);

      if (opts.rename) {
        // rename mode: move source file content whole to canonical
        if (canonExists) {
          // Canonical already exists — fall back to merge-prepend to avoid data loss
          const canonRaw = await readFile(canonPath, "utf-8");
          const today = new Date().toISOString().slice(0, 10);
          const dated = `\n### Renamed from [[${source}]] on ${today}\n\n${srcBody.trim()}\n`;
          const merged = insertAfterFrontmatter(canonRaw, dated);
          await writeFile(canonPath, merged, "utf-8");
        } else {
          const renamed = renameInFrontmatter(srcRaw, source, canonical);
          await writeFile(canonPath, renamed, "utf-8");
        }
      } else if (canonExists) {
        // merge mode: prepend dated section to canonical content
        const canonRaw = await readFile(canonPath, "utf-8");
        const today = new Date().toISOString().slice(0, 10);
        const dated = `\n### Merged from [[${source}]] on ${today}\n\n${srcBody.trim()}\n`;
        const merged = insertAfterFrontmatter(canonRaw, dated);
        await writeFile(canonPath, merged, "utf-8");
      } else {
        // canonical doesn't exist: treat as rename
        const renamed = renameInFrontmatter(srcRaw, source, canonical);
        await writeFile(canonPath, renamed, "utf-8");
      }
    }

    // Step 3: fact store merge
    if (await fileExists(srcFactsPath)) {
      const srcFacts = await readFile(srcFactsPath, "utf-8");
      if (await fileExists(canonFactsPath)) {
        const existing = await readFile(canonFactsPath, "utf-8");
        await writeFile(canonFactsPath, existing + srcFacts, "utf-8");
      } else {
        await writeFile(canonFactsPath, srcFacts, "utf-8");
      }
    }
  }

  // Step 4: delete source
  if (await fileExists(srcPath)) await unlink(srcPath);
  if (await fileExists(srcFactsPath)) await unlink(srcFactsPath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rewriteLinks(warmDir: string, source: string, canonical: string | null): Promise<void> {
  const files = await readdir(warmDir);
  const mdFiles = files.filter((f) => f.endsWith(".md") && f !== `${source}.md`);
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[\\[${escaped}\\]\\]`, "g");
  const replacement = canonical !== null ? `[[${canonical}]]` : source;
  for (const f of mdFiles) {
    const path = join(warmDir, f);
    const raw = await readFile(path, "utf-8");
    if (!raw.includes(`[[${source}]]`)) continue;
    const rewritten = raw.replace(pattern, replacement);
    if (rewritten !== raw) await writeFile(path, rewritten, "utf-8");
  }
}

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n/);
  return m ? raw.slice(m[0].length) : raw;
}

function insertAfterFrontmatter(raw: string, insertion: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) return raw + insertion;
  return raw.slice(0, m[0].length) + insertion + raw.slice(m[0].length);
}

function renameInFrontmatter(raw: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(new RegExp(`^theme:\\s*${escaped}\\b`, "m"), `theme: ${to}`);
}
