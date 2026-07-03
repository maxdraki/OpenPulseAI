import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, loadConfig, createProvider, initLogger, vaultLog, type LlmProvider } from "@openpulse/core";
import { handleRecordActivity } from "./tools/record-activity.js";
import { handleIngestDocument } from "./tools/ingest-document.js";
import { handleQueryMemory } from "./tools/query-memory.js";
import { handleSubmitUpdate } from "./tools/submit-update.js";
import { handleSearchIndex } from "./tools/search-index.js";
import { handleReadTheme } from "./tools/read-theme.js";
import { handleChatWithPulse } from "./tools/chat-with-pulse.js";

export async function createServer(vaultRoot: string, opts?: { provider?: LlmProvider }) {
  initLogger(vaultRoot);

  const vault = new Vault(vaultRoot);
  await vault.init();

  const config = await loadConfig(vaultRoot);
  let provider = opts?.provider ?? null;
  if (!provider) {
    try { provider = createProvider(config); } catch { /* no API key */ }
  }

  await vaultLog("info", "MCP server started", `vault: ${vaultRoot}, provider: ${config.llm.provider}/${config.llm.model}`);

  const server = new McpServer({ name: "openpulse", version: "0.1.0" });

  // Wrap a tool handler with vault logging (info on call, error on failure)
  function logged<T>(name: string, detailFn: (input: any) => string, handler: (input: any) => Promise<T>) {
    return async (input: any): Promise<T> => {
      await vaultLog("info", `MCP: ${name}`, detailFn(input));
      try {
        return await handler(input);
      } catch (e: any) {
        await vaultLog("error", `MCP: ${name} failed`, e.message);
        throw e;
      }
    };
  }

  server.tool(
    "record_activity",
    "Record development activity (a journal entry) to the OpenPulse vault — use this whenever you want to log what you just did, from any source (an agent, a script, a human note). Accepts an optional theme (to steer downstream classification) and an optional source label (e.g. \"github-bot\", \"slack\"). This is a write to the hot layer only; it becomes queryable via query_memory/search_index after the Dream Pipeline synthesizes it into a theme page.",
    { log: z.string(), theme: z.string().optional(), source: z.string().optional() },
    logged("record_activity", (i) => `theme: ${i.theme ?? "auto"}, source: ${i.source ?? "none"}, ${i.log.slice(0, 100)}...`,
      (input) => handleRecordActivity(vault, input))
  );

  server.tool(
    "ingest_document",
    "Ingest a whole Markdown document (not a short activity note) into the OpenPulse vault for later thematic processing — use this for larger source material (design docs, meeting notes, specs) rather than record_activity's short log lines.",
    { filename: z.string(), content: z.string() },
    logged("ingest_document", (i) => `file: ${i.filename} (${i.content.length} chars)`,
      (input) => handleIngestDocument(vault, input))
  );

  server.tool(
    "query_memory",
    "Retrieve full curated theme pages relevant to a query, keyword-matched over warm (already-synthesized) themes. For a lighter-weight narrow-then-read flow, prefer search_index (ranked snippets across all themes) followed by read_theme (fetch one page in full) — query_memory is the older, single-step alternative.",
    { query: z.string() },
    logged("query_memory", (i) => `query: ${i.query}`,
      (input) => handleQueryMemory(vault, input))
  );

  server.tool(
    "submit_update",
    "Deprecated: use record_activity instead (submit_update is now a thin alias kept only for backward compatibility with existing clients — it requires a `source` field where record_activity treats it as optional).",
    { content: z.string(), source: z.string(), theme: z.string().optional() },
    logged("submit_update", (i) => `source: ${i.source}, theme: ${i.theme ?? "auto"}`,
      (input) => handleSubmitUpdate(vault, input))
  );

  server.tool(
    "search_index",
    "Search first, then read_theme for full pages: ranked snippet-level search over the local full-text index of all warm themes. Returns theme name, heading, snippet, and score for each hit — use the theme name with read_theme to fetch the complete page. Prefer this over query_memory when you don't yet know which theme(s) are relevant.",
    { query: z.string(), limit: z.number().int().positive().optional() },
    logged("search_index", (i) => `query: ${i.query}, limit: ${i.limit ?? "default"}`,
      (input) => handleSearchIndex(vault, input))
  );

  server.tool(
    "read_theme",
    "Read the full Markdown content of one warm theme page by exact name, discovered via search_index or query_memory. Returns a not-found error with close-match suggestions if the name doesn't exist.",
    { theme: z.string() },
    logged("read_theme", (i) => `theme: ${i.theme}`,
      (input) => handleReadTheme(vault, input))
  );

  if (provider) {
    server.tool(
      "chat_with_pulse",
      "Have a multi-turn conversation about recorded activities and knowledge — the LLM itself decides how to search the vault across turns. Use this for open-ended, conversational questions; use search_index/read_theme or query_memory directly for a single, deterministic lookup.",
      { message: z.string(), sessionId: z.string().optional() },
      logged("chat_with_pulse", (i) => `session: ${i.sessionId ?? "new"}, msg: ${i.message.slice(0, 80)}...`,
        async (input) => {
          const result = await handleChatWithPulse(vault, provider!, config.llm.model, input);
          return { content: result.content };
        })
    );
  }

  server.resource(
    "wiki-index",
    "openpulse://index",
    { title: "OpenPulse Wiki Index", mimeType: "text/markdown", description: "Auto-generated catalog of every warm theme page — the map for the narrow-then-read pattern." },
    async (uri) => {
      let text: string;
      try {
        text = await readFile(vault.warmDir + "/index.md", "utf-8");
      } catch {
        text = "# OpenPulse Wiki Index\n\nNo themes yet — nothing has been synthesized into the warm layer.";
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  server.prompt(
    "summarize_my_week",
    "Summarize recent recorded activity and knowledge into a status update.",
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Summarize my work from this past week. Use search_index to find themes touched recently, then read_theme to pull the full content of each relevant page, and also check vault/warm/log.md for a chronological record of Dream Pipeline activity. Compose a concise summary organized by theme, highlighting what changed and what's still in progress.",
          },
        },
      ],
    })
  );

  server.prompt(
    "what_do_i_know_about",
    "Answer what OpenPulse knows about a given topic using the narrow-then-read pattern.",
    { topic: z.string() },
    async ({ topic }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find out what is known about "${topic}". First call search_index with a query about "${topic}" to find the most relevant theme(s), then call read_theme on the best match(es) to get the full page content. Answer using only what you find — say so plainly if nothing relevant turns up.`,
          },
        },
      ],
    })
  );

  return { server, vault };
}
