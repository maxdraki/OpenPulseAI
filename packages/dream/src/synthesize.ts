import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Vault,
  type ClassificationResult,
  type LlmProvider,
  type PendingUpdate,
  readTheme,
} from "@openpulse/core";

export async function synthesizeToPending(
  vault: Vault,
  classified: ClassificationResult[],
  provider: LlmProvider,
  model: string
): Promise<PendingUpdate[]> {
  const byTheme = new Map<string, ClassificationResult[]>();
  for (const item of classified) {
    const group = byTheme.get(item.theme) ?? [];
    group.push(item);
    byTheme.set(item.theme, group);
  }

  const pending: PendingUpdate[] = [];

  for (const [theme, items] of byTheme) {
    const existing = await readTheme(vault, theme);
    const newEntries = items
      .map((i) => ({ timestamp: i.entry.timestamp, log: i.entry.log }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const newEntriesText = newEntries
      .map((e) => `- ${e.timestamp}: ${e.log}`)
      .join("\n");

    const existingSection = existing?.content
      ? `Current content of "${theme}":\n${existing.content}\n\n`
      : "";

    const proposedContent = await provider.complete({
      model,
      prompt: `You are maintaining a status document for the theme "${theme}".

${existingSection}New activity entries:
${newEntriesText}

Write an updated status document following these rules:

1. Start with "## Current Status" — a brief summary of the LATEST state
2. PRESERVE all existing activity log entries from the current content — do NOT remove historical entries
3. ADD the new entries as new dated sections in the activity log (most recent first)
4. If a new entry updates or supersedes an older one, update the Current Status but KEEP the old activity log entry for history
5. Remove only exact duplicates (same date, same content)
6. Use clear, concise Markdown

The document structure should be:
## Current Status
(brief summary of latest state)

## Activity Log
### [Date] — [Title]
(details)
### [Earlier Date] — [Earlier Title]
(details)
...

Before returning your answer, verify every repository name, PR number, issue number, and factual claim against the source entries and existing content above. Remove anything you cannot trace back to a specific source. If you are unsure whether something is real, leave it out.

Return ONLY the Markdown content, no fences or explanations.`,
      systemPrompt: `You are a precise factual summarizer. You MUST only include information that is explicitly present in the provided activity entries or existing content. NEVER invent, fabricate, or hallucinate any data including:
- Repository names, project names, or organization names
- PR numbers, issue numbers, or commit hashes
- People's names, team names, or roles
- Dates, metrics, or statistics
- Actions taken or decisions made

If the source data is sparse, write a short summary. An accurate 2-line summary is better than a detailed paragraph with invented details. When in doubt, quote the source entry directly rather than paraphrasing with added context.`,
      maxTokens: 2048,
    });

    const update: PendingUpdate = {
      id: randomUUID(),
      theme,
      proposedContent,
      previousContent: existing?.content ?? null,
      entries: items.map((i) => i.entry),
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    const filename = `${update.id}.json`;
    await writeFile(
      join(vault.pendingDir, filename),
      JSON.stringify(update, null, 2),
      "utf-8"
    );

    pending.push(update);
  }

  return pending;
}
