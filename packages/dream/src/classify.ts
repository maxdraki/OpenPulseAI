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
    prompt: `Classify each numbered entry into one of these themes: ${existingThemes.join(", ")}. If none fit, suggest a new theme name (lowercase-kebab-case).

Entries:
${entriesText}

Respond with a JSON array of objects: [{"index": 0, "theme": "theme-name", "confidence": 0.9}, ...]
Return ONLY the JSON array, no other text.`,
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
