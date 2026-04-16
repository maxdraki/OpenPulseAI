import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault, LlmProvider, ThemeDocument } from "@openpulse/core";
import { readAllThemes, readTheme } from "@openpulse/core";
import { createNewSession, loadSession, saveSession } from "./chat-session.js";
import { searchWarmFiles } from "../search.js";

export interface ChatWithPulseInput {
  message: string;
  sessionId?: string;
}

export interface ChatWithPulseResult {
  content: Array<{ type: "text"; text: string }>;
  sessionId: string;
}

export async function handleChatWithPulse(
  vault: Vault,
  provider: LlmProvider,
  model: string,
  input: ChatWithPulseInput
): Promise<ChatWithPulseResult> {
  let session = input.sessionId ? await loadSession(vault, input.sessionId) : null;
  if (!session) session = createNewSession();

  // Handle "file: <page-name>" replies — create a concept page pending update
  const fileMatch = input.message.match(/^file:\s*(.+)$/i);
  if (fileMatch && session) {
    const { writeFile } = await import("node:fs/promises");
    const { join: pathJoin } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const proposedName = fileMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
    // Find the last assistant message that contained a file-this-answer offer — that's
    // the answer we want to capture, not a subsequent follow-up reply.
    const assistantMessages = session.messages.filter((m) => m.role === "assistant");
    const sourceMessage = [...assistantMessages].reverse().find((m) => m.content.includes("_This answer draws")) ??
      assistantMessages.at(-1);
    const cleanAnswer = (sourceMessage?.content ?? "").replace(/_This answer draws.*$/s, "").trim();

    // Build sources list from themes consulted in this session
    const sourcesSection = session.themesConsulted.length > 0
      ? `\n\n## Sources\n\nDerived from: ${session.themesConsulted.map(t => `[[${t}]]`).join(", ")}`
      : "\n\n## Sources\n";

    const proposedContent = `## Definition\n\n${cleanAnswer}\n\n## Key Claims\n\n## Related Concepts\n${sourcesSection}\n`;
    const update = {
      id: randomUUID(),
      theme: proposedName,
      proposedContent,
      previousContent: null as null,
      entries: [] as [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      type: "concept" as const,
      batchId: new Date().toISOString(),
      related: session.themesConsulted.length > 0 ? session.themesConsulted : undefined,
    };

    await writeFile(
      pathJoin(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8"
    );

    const confirmText = `Created pending concept page "[[${proposedName}]]". Review it in the Control Center.`;
    session.messages.push({ role: "user", content: input.message });
    session.messages.push({ role: "assistant", content: confirmText });
    await saveSession(vault, session);

    return {
      content: [{ type: "text" as const, text: `${confirmText}\n\n_[session: ${session.id}]_` }],
      sessionId: session.id,
    };
  }

  // Find relevant warm themes
  let allThemes: ThemeDocument[] | undefined;
  try {
    const indexContent = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    const themeEntries = [...indexContent.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);

    // Find relevant themes: query words match theme name or index summary
    const queryWords = input.message.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const indexLower = indexContent.toLowerCase();

    const relevant = themeEntries.filter(name => {
      const nameLower = name.toLowerCase();
      return queryWords.some(w => nameLower.includes(w)) ||
             queryWords.some(w => {
               // Check the line containing this theme for query matches
               const lineStart = indexLower.indexOf(`[[${nameLower}]]`);
               if (lineStart < 0) return false;
               const lineEnd = indexContent.indexOf('\n', lineStart);
               const line = indexLower.slice(lineStart, lineEnd > 0 ? lineEnd : undefined);
               return line.includes(w);
             });
    });

    if (relevant.length > 0) {
      const loaded = await Promise.all(relevant.map((name) => readTheme(vault, name)));
      allThemes = loaded.filter((t): t is ThemeDocument => t !== null);
    }
  } catch { /* index.md doesn't exist yet */ }

  // Fallback
  if (!allThemes || allThemes.length === 0) {
    const relevantThemes = await searchWarmFiles(vault, input.message);
    allThemes = relevantThemes.length > 0 ? relevantThemes : await readAllThemes(vault);
  }
  session.themesConsulted = [...new Set([
    ...session.themesConsulted,
    ...allThemes.map((t) => t.theme),
  ])];

  const context = allThemes
    .map((t) => `## ${t.theme}\n${t.content}`)
    .join("\n\n---\n\n");

  const history = session.messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  session.messages.push({ role: "user", content: input.message });

  const prompt = [
    history ? `Previous conversation:\n${history}\n\n` : "",
    `User: ${input.message}`,
  ].join("");

  const systemPrompt = `You are a work assistant that helps the user understand what's happening across their projects and work activity. You have access to curated status pages (called "themes") that are maintained from automated data collection.

Answer questions based ONLY on the knowledge below. Be concise and accurate. If the knowledge doesn't contain information about something, say "I don't have data on that" rather than guessing. Never invent repository names, PR numbers, project names, dates, or any details not present below.

${context}`;

  const response = await provider.complete({ model, prompt, systemPrompt, temperature: 0.5 });

  // Count themes consulted in this turn
  const thisCallThemes = allThemes?.map((t) => t.theme) ?? [];
  const fileOffer = thisCallThemes.length >= 3
    ? `\n\n_This answer draws from ${thisCallThemes.length} theme${thisCallThemes.length === 1 ? "" : "s"} (${thisCallThemes.slice(0, 3).map((n) => `[[${n}]]`).join(", ")}${thisCallThemes.length > 3 ? "…" : ""}). File it as a new concept page? Reply with \`file: <page-name>\` to create a pending concept page._`
    : "";

  const fullResponse = response + fileOffer;

  session.messages.push({ role: "assistant", content: fullResponse });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: `${fullResponse}\n\n_[session: ${session.id}]_` }],
    sessionId: session.id,
  };
}
