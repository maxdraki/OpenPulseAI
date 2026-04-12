import type { ActivityEntry, ClassificationResult, LlmProvider } from "@openpulse/core";

export async function classifyEntries(
  entries: ActivityEntry[],
  existingThemes: string[],
  provider: LlmProvider,
  model: string
): Promise<ClassificationResult[]> {
  const tagged: ClassificationResult[] = [];
  const untagged: ActivityEntry[] = [];

  for (const entry of entries) {
    if (entry.theme && existingThemes.includes(entry.theme)) {
      tagged.push({ entry, theme: entry.theme, confidence: 1.0 });
    } else {
      untagged.push(entry);
    }
  }

  if (untagged.length === 0) return tagged;

  const entriesText = untagged
    .map((e, i) => `[${i}] ${e.timestamp}: ${e.log}`)
    .join("\n");

  const responseText = await provider.complete({
    model,
    prompt: `Classify each numbered entry into a theme. Existing themes: ${existingThemes.length > 0 ? existingThemes.join(", ") : "(none yet)"}.

Rules for theme names:
- Use the PROJECT NAME as the theme when the entry is about a specific project (e.g., "openpulse", "aigis", "gustave")
- Use a TOPIC name only for cross-project entries (e.g., "weekly-status", "infrastructure")
- Theme names must be lowercase-kebab-case
- Prefer specific themes over generic ones — "openpulse" is better than "development-logs"
- Create new themes freely when existing ones don't fit well

Entries:
${entriesText}

Respond with a JSON array of objects: [{"index": 0, "theme": "theme-name", "confidence": 0.9}, ...]
Return ONLY the JSON array, no other text.`,
    systemPrompt: `You are classifying activity log entries into themes. Each theme should represent a distinct project or topic. Never lump unrelated projects into a single theme. When in doubt, create a new theme.`,
  });

  const parsed = JSON.parse(responseText) as Array<{
    index: number;
    theme: string;
    confidence: number;
  }>;

  const llmResults = parsed.map((p) => ({
    entry: untagged[p.index],
    theme: p.theme,
    confidence: p.confidence,
  }));

  return [...tagged, ...llmResults];
}
