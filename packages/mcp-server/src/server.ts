import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault } from "@openpulse/core";
import { handleRecordActivity } from "./tools/record-activity.js";
import { handleIngestDocument } from "./tools/ingest-document.js";
import { handleQueryMemory } from "./tools/query-memory.js";

export async function createServer(vaultRoot: string) {
  const vault = new Vault(vaultRoot);
  await vault.init();

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

  return { server, vault };
}
