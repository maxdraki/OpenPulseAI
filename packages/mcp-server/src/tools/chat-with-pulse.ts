import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

interface JudgeResult {
  verdict: "yes" | "no" | "maybe";
  proposed_name: string | null;
  one_line_definition: string | null;
  refined_content: string | null;
}

async function judgeAndRefine(
  provider: LlmProvider,
  model: string,
  question: string,
  answer: string,
  themesConsulted: string[],
): Promise<JudgeResult> {
  try {
    const response = await provider.complete({
      model,
      temperature: 0,
      prompt: `Question: ${question}

Answer: ${answer}

Themes consulted: ${themesConsulted.join(", ")}

Is this answer durable, reusable knowledge worth a wiki concept page, or ephemeral Q&A?

Return ONLY JSON:
{
  "verdict": "yes" | "no" | "maybe",
  "proposed_name": <kebab-case slug> | null,
  "one_line_definition": <string> | null,
  "refined_content": <full concept-page markdown with "## Definition", "## Key Claims", "## Related Concepts", "## Sources" sections> | null
}
All fields null if verdict is "no".`,
    });
    let j = response.trim();
    if (j.startsWith("```")) j = j.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const parsed = JSON.parse(j) as JudgeResult;
    if (!["yes", "no", "maybe"].includes(parsed.verdict)) {
      return { verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null };
    }
    return parsed;
  } catch {
    return { verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null };
  }
}

function sanitizeSlug(name: string): string {
  return name.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[\/\\]/g, "")
    .replace(/\.\./g, "")
    .replace(/^[-_.]+/, "")
    .slice(0, 100);
}

export async function handleChatWithPulse(
  vault: Vault,
  provider: LlmProvider,
  model: string,
  input: ChatWithPulseInput
): Promise<ChatWithPulseResult> {
  let session = input.sessionId ? await loadSession(vault, input.sessionId) : null;
  if (!session) session = createNewSession();

  // If the user replies "file: yes" and session has a stashed pending file (from a "maybe"
  // judge verdict on the previous turn), create the pending concept update now.
  if (session && /^file:\s*yes\b/i.test(input.message) && session.pendingFile) {
    const pf = session.pendingFile;
    const update = {
      id: randomUUID(),
      theme: pf.name,
      proposedContent: pf.content,
      previousContent: null as null,
      entries: [] as [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId: new Date().toISOString(),
      type: "concept" as const,
      related: pf.themesConsulted.length > 0 ? pf.themesConsulted : undefined,
      querybackSource: { question: pf.question, themesConsulted: pf.themesConsulted },
    };
    await writeFile(
      join(vault.pendingDir, `${update.id}.json`),
      JSON.stringify(update, null, 2),
      "utf-8",
    );
    session.pendingFile = undefined;
    const confirmText = `Filed [[${pf.name}]] as a pending concept page. Review it in the Control Center.`;
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

  let response = await provider.complete({ model, prompt, systemPrompt, temperature: 0.5 });

  // Themes actually consulted in THIS turn (not cumulative across session).
  const thisCallThemes = allThemes?.map((t) => t.theme) ?? [];

  // Query-back: judge + refine when ≥ 2 themes consulted. Cheap LLM call decides
  // whether this answer is durable knowledge worth a concept page.
  if (thisCallThemes.length >= 2 && session) {
    const judgment = await judgeAndRefine(provider, model, input.message, response, thisCallThemes);

    if (judgment.verdict === "yes" && judgment.proposed_name && judgment.refined_content) {
      const themeName = sanitizeSlug(judgment.proposed_name);
      const update = {
        id: randomUUID(),
        theme: themeName,
        proposedContent: judgment.refined_content,
        previousContent: null as null,
        entries: [] as [],
        createdAt: new Date().toISOString(),
        status: "pending" as const,
        batchId: new Date().toISOString(),
        type: "concept" as const,
        related: thisCallThemes.length > 0 ? thisCallThemes : undefined,
        querybackSource: { question: input.message, themesConsulted: thisCallThemes },
      };
      await writeFile(
        join(vault.pendingDir, `${update.id}.json`),
        JSON.stringify(update, null, 2),
        "utf-8",
      );
      response += `\n\n_Filed [[${themeName}]] as a pending concept page. Review it in the Control Center._`;
    } else if (judgment.verdict === "maybe" && judgment.proposed_name && judgment.refined_content) {
      const slug = sanitizeSlug(judgment.proposed_name);
      session.pendingFile = {
        name: slug,
        content: judgment.refined_content,
        question: input.message,
        themesConsulted: thisCallThemes,
      };
      response += `\n\n_This looks like durable knowledge. Reply \`file: yes\` to save as [[${slug}]]._`;
    }
    // verdict === "no": do nothing (no noise in response)
  }

  session.messages.push({ role: "assistant", content: response });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: `${response}\n\n_[session: ${session.id}]_` }],
    sessionId: session.id,
  };
}
