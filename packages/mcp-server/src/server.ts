import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, loadConfig, createProvider, type LlmProvider } from "@openpulse/core";
import { handleRecordActivity } from "./tools/record-activity.js";
import { handleIngestDocument } from "./tools/ingest-document.js";
import { handleQueryMemory } from "./tools/query-memory.js";
import { handleSubmitUpdate } from "./tools/submit-update.js";
import { handleChatWithPulse } from "./tools/chat-with-pulse.js";

export async function createServer(vaultRoot: string, opts?: { provider?: LlmProvider }) {
  const vault = new Vault(vaultRoot);
  await vault.init();

  const config = await loadConfig(vaultRoot);
  let provider = opts?.provider ?? null;
  if (!provider) {
    try { provider = createProvider(config); } catch { /* no API key */ }
  }

  const server = new McpServer({ name: "openpulse", version: "0.1.0" });

  server.tool(
    "record_activity",
    "Record development activity to the OpenPulse vault. Use this to log what you just did.",
    { log: z.string(), theme: z.string().optional() },
    async (input) => handleRecordActivity(vault, input)
  );

  server.tool(
    "ingest_document",
    "Ingest a Markdown document into the OpenPulse vault for later thematic processing.",
    { filename: z.string(), content: z.string() },
    async (input) => handleIngestDocument(vault, input)
  );

  server.tool(
    "query_memory",
    "Query the OpenPulse vault for status information. Returns relevant thematic summaries.",
    { query: z.string() },
    async (input) => handleQueryMemory(vault, input)
  );

  server.tool(
    "submit_update",
    "Push a Markdown status update into the OpenPulse hot layer.",
    { content: z.string(), source: z.string(), theme: z.string().optional() },
    async (input) => handleSubmitUpdate(vault, input)
  );

  if (provider) {
    server.tool(
      "chat_with_pulse",
      "Have a multi-turn conversation about recorded activities and knowledge.",
      { message: z.string(), sessionId: z.string().optional() },
      async (input) => handleChatWithPulse(vault, provider!, config.llm.model, input)
    );
  }

  return { server, vault };
}
