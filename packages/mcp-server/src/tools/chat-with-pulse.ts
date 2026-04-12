import type { Vault, LlmProvider } from "@openpulse/core";
import { readAllThemes } from "@openpulse/core";
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
  const relevantThemes = await searchWarmFiles(vault, input.message);
  const allThemes = relevantThemes.length > 0 ? relevantThemes : await readAllThemes(vault);
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

  const systemPrompt = `You are OpenPulse, a Digital Twin proxy. Answer questions based ONLY on the following curated knowledge. Be concise and accurate. NEVER invent repository names, PR numbers, project names, or any other details not explicitly present in the knowledge below. If you don't have information about something, say "I don't have data on that" rather than guessing.\n\n${context}`;

  const response = await provider.complete({ model, prompt, systemPrompt, temperature: 0.5 });

  session.messages.push({ role: "assistant", content: response });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: `${response}\n\n_[session: ${session.id}]_` }],
    sessionId: session.id,
  };
}
