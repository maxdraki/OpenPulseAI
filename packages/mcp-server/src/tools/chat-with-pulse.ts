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

  session.messages.push({ role: "assistant", content: response });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: `${response}\n\n_[session: ${session.id}]_` }],
    sessionId: session.id,
  };
}
