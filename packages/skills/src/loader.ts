import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";
import type { SkillDefinition, SkillConfigField } from "@openpulse/core";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

export function parseFrontmatter(
  content: string
): Omit<SkillDefinition, "location" | "body"> | null {
  try {
    const parsed = load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const name = parsed.name;
    const description = parsed.description;
    if (typeof name !== "string" || typeof description !== "string") return null;

    const requires = parsed.requires as Record<string, unknown> | undefined;

    // Parse config fields
    const rawConfig = parsed.config as Array<Record<string, unknown>> | undefined;
    const config: SkillConfigField[] | undefined = Array.isArray(rawConfig)
      ? rawConfig
          .filter((c) => typeof c?.key === "string" && typeof c?.label === "string")
          .map((c) => ({
            key: c.key as string,
            label: c.label as string,
            default: typeof c.default === "string" ? c.default : undefined,
            type: (c.type === "path" ? "path" : "text") as "text" | "path",
          }))
      : undefined;

    return {
      name: name.replace(/[:\\/<>*?"|]/g, "-"),
      description,
      schedule: typeof parsed.schedule === "string" ? parsed.schedule : undefined,
      lookback: typeof parsed.lookback === "string" ? parsed.lookback : "24h",
      requires: {
        bins: Array.isArray(requires?.bins) ? requires.bins.filter((b): b is string => typeof b === "string") : [],
        env: Array.isArray(requires?.env) ? requires.env.filter((e): e is string => typeof e === "string") : [],
      },
      config,
    };
  } catch {
    return null;
  }
}

export async function loadSkillFromFile(filePath: string): Promise<SkillDefinition | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return null;
    const frontmatter = parseFrontmatter(match[1]);
    if (!frontmatter) return null;
    return { ...frontmatter, location: filePath, body: match[2]?.trim() ?? "" };
  } catch {
    return null;
  }
}

export async function loadSkillsFromDir(dir: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  try {
    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      const skill = await loadSkillFromFile(skillFile);
      if (skill) skills.push(skill);
    }
  } catch { return []; }
  return skills;
}

export async function discoverSkills(dirs: string[]): Promise<SkillDefinition[]> {
  const skillMap = new Map<string, SkillDefinition>();
  for (const dir of dirs) {
    const skills = await loadSkillsFromDir(dir);
    for (const skill of skills) {
      skillMap.set(skill.name, skill);
    }
  }
  return Array.from(skillMap.values());
}
