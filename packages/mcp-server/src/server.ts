import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, loadConfig, createProvider, initLogger, vaultLog, type LlmProvider } from "@openpulse/core";
import { handleRecordActivity } from "./tools/record-activity.js";
import { handleIngestDocument } from "./tools/ingest-document.js";
import { handleQueryMemory } from "./tools/query-memory.js";
import { handleSubmitUpdate } from "./tools/submit-update.js";
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
    "Record development activity to the OpenPulse vault. Use this to log what you just did.",
    { log: z.string(), theme: z.string().optional() },
    logged("record_activity", (i) => `theme: ${i.theme ?? "auto"}, ${i.log.slice(0, 100)}...`,
      (input) => handleRecordActivity(vault, input))
  );

  server.tool(
    "ingest_document",
    "Ingest a Markdown document into the OpenPulse vault for later thematic processing.",
    { filename: z.string(), content: z.string() },
    logged("ingest_document", (i) => `file: ${i.filename} (${i.content.length} chars)`,
      (input) => handleIngestDocument(vault, input))
  );

  server.tool(
    "query_memory",
    "Query the OpenPulse vault for status information. Returns relevant thematic summaries.",
    { query: z.string() },
    logged("query_memory", (i) => `query: ${i.query}`,
      (input) => handleQueryMemory(vault, input))
  );

  server.tool(
    "submit_update",
    "Push a Markdown status update into the OpenPulse hot layer.",
    { content: z.string(), source: z.string(), theme: z.string().optional() },
    logged("submit_update", (i) => `source: ${i.source}, theme: ${i.theme ?? "auto"}`,
      (input) => handleSubmitUpdate(vault, input))
  );

  if (provider) {
    server.tool(
      "chat_with_pulse",
      "Have a multi-turn conversation about recorded activities and knowledge.",
      { message: z.string(), sessionId: z.string().optional() },
      logged("chat_with_pulse", (i) => `session: ${i.sessionId ?? "new"}, msg: ${i.message.slice(0, 80)}...`,
        async (input) => {
          const result = await handleChatWithPulse(vault, provider!, config.llm.model, input);
          return { content: result.content };
        })
    );
  }

  return { server, vault };
}
