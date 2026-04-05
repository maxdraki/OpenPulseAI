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

Write an updated status document that:
1. Incorporates the new entries into the existing content
2. Uses the latest timestamp as the source of truth when entries conflict
3. Removes duplicate information
4. Is written in clear, concise Markdown
5. Starts with a "## Current Status" heading

Before returning your answer, verify every repository name, PR number, issue number, and factual claim against the source entries above. Remove anything you cannot trace back to a specific entry. If you are unsure whether something is real, leave it out.

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
