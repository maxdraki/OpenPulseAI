import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "@openpulse/core";
import type { ThemeType } from "@openpulse/core";

export interface SchemaTemplate {
  structure: string; // section headings for this type
  rules: string;     // synthesis rules for this type
}

export const DEFAULT_TEMPLATES: Record<ThemeType, SchemaTemplate> = {
  project: {
    structure: "## Current Status\n## Activity Log",
    rules:
      "Preserve all historical entries. Most-recent-first in Activity Log. One ### section per date. Never produce two ### sections with the same date.",
  },
  concept: {
    structure: "## Definition\n## Key Claims\n## Related Concepts\n## Sources",
    rules:
      "Durable synthesis — not chronological. Update in place when new evidence arrives. Never append dated sections.",
  },
  entity: {
    structure: "## Summary\n## References in Wiki\n## Recent Activity\n## Sources",
    rules:
      "Entity is a person, tool, repo, or external project. Keep Summary short (2-3 sentences).",
  },
  "source-summary": {
    structure: "## Source\n## Key Takeaways\n## Referenced In",
    rules:
      "One page per ingested document. Key Takeaways are bullet points. Referenced In lists [[wiki-links]] that cite this source.",
  },
};

export const DEFAULT_SCHEMA_CONTENT = `# Wiki Schema

### project
Structure: ## Current Status\\n## Activity Log
Rules: Preserve all historical entries. Most-recent-first in Activity Log. One ### section per date. Never produce two ### sections with the same date.

### concept
Structure: ## Definition\\n## Key Claims\\n## Related Concepts\\n## Sources
Rules: Durable synthesis — not chronological. Update in place when new evidence arrives. Never append dated sections.

### entity
Structure: ## Summary\\n## References in Wiki\\n## Recent Activity\\n## Sources
Rules: Entity is a person, tool, repo, or external project. Keep Summary short (2-3 sentences).

### source-summary
Structure: ## Source\\n## Key Takeaways\\n## Referenced In
Rules: One page per ingested document. Key Takeaways are bullet points. Referenced In lists [[wiki-links]] that cite this source.
`;

export async function loadSchema(vault: Vault): Promise<Record<ThemeType, SchemaTemplate>> {
  try {
    const raw = await readFile(join(vault.warmDir, "_schema.md"), "utf-8");
    return parseSchema(raw);
  } catch {
    return { ...DEFAULT_TEMPLATES };
  }
}

export async function seedSchema(vault: Vault): Promise<void> {
  const path = join(vault.warmDir, "_schema.md");
  try {
    await stat(path); // already exists — do nothing
  } catch {
    await writeFile(path, DEFAULT_SCHEMA_CONTENT, "utf-8");
  }
}

export function parseSchema(raw: string): Record<ThemeType, SchemaTemplate> {
  const templates: Record<ThemeType, SchemaTemplate> = { ...DEFAULT_TEMPLATES };
  const types: ThemeType[] = ["project", "concept", "entity", "source-summary"];
  for (const type of types) {
    const section = raw.match(new RegExp(`### ${type}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`));
    if (!section) continue;
    // Match "Structure:" or "Rules:" through end of value (possibly multi-line, until next key or end of section)
    const structureLine = section[1].match(/Structure: ([\s\S]+?)(?=\nRules:|\n###|\n##|$)/);
    const rulesLine = section[1].match(/Rules: ([\s\S]+?)(?=\nStructure:|\n###|\n##|$)/);
    if (structureLine) templates[type] = { ...templates[type], structure: structureLine[1].trim().replace(/\\n/g, "\n") };
    if (rulesLine) templates[type] = { ...templates[type], rules: rulesLine[1].trim().replace(/\\n/g, "\n") };
  }
  return templates;
}
