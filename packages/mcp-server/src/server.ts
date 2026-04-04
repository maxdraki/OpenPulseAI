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

  server.tool(
    "record_activity",
    "Record development activity to the OpenPulse vault. Use this to log what you just did.",
    { log: z.string(), theme: z.string().optional() },
    async (input) => {
      await vaultLog("info", "MCP: record_activity", `theme: ${input.theme ?? "auto"}, ${input.log.slice(0, 100)}...`);
      try {
        const result = await handleRecordActivity(vault, input);
        return result;
      } catch (e: any) {
        await vaultLog("error", "MCP: record_activity failed", e.message);
        throw e;
      }
    }
  );

  server.tool(
    "ingest_document",
    "Ingest a Markdown document into the OpenPulse vault for later thematic processing.",
    { filename: z.string(), content: z.string() },
    async (input) => {
      await vaultLog("info", "MCP: ingest_document", `file: ${input.filename} (${input.content.length} chars)`);
      try {
        const result = await handleIngestDocument(vault, input);
        return result;
      } catch (e: any) {
        await vaultLog("error", "MCP: ingest_document failed", e.message);
        throw e;
      }
    }
  );

  server.tool(
    "query_memory",
    "Query the OpenPulse vault for status information. Returns relevant thematic summaries.",
    { query: z.string() },
    async (input) => {
      await vaultLog("info", "MCP: query_memory", `query: ${input.query}`);
      try {
        const result = await handleQueryMemory(vault, input);
        return result;
      } catch (e: any) {
        await vaultLog("error", "MCP: query_memory failed", e.message);
        throw e;
      }
    }
  );

  server.tool(
    "submit_update",
    "Push a Markdown status update into the OpenPulse hot layer.",
    { content: z.string(), source: z.string(), theme: z.string().optional() },
    async (input) => {
      await vaultLog("info", "MCP: submit_update", `source: ${input.source}, theme: ${input.theme ?? "auto"}`);
      try {
        const result = await handleSubmitUpdate(vault, input);
        return result;
      } catch (e: any) {
        await vaultLog("error", "MCP: submit_update failed", e.message);
        throw e;
      }
    }
  );

  if (provider) {
    server.tool(
      "chat_with_pulse",
      "Have a multi-turn conversation about recorded activities and knowledge.",
      { message: z.string(), sessionId: z.string().optional() },
      async (input) => {
        await vaultLog("info", "MCP: chat_with_pulse", `session: ${input.sessionId ?? "new"}, msg: ${input.message.slice(0, 80)}...`);
        try {
          const result = await handleChatWithPulse(vault, provider!, config.llm.model, input);
          return { content: result.content };
        } catch (e: any) {
          await vaultLog("error", "MCP: chat_with_pulse failed", e.message);
          throw e;
        }
      }
    );
  }

  return { server, vault };
}
