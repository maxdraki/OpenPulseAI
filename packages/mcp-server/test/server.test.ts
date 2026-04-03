import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

describe("MCP server integration", () => {
  let tempDir: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-server-"));

    const { server } = await createServer(tempDir);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { recursive: true });
  });

  it("lists all 3 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("record_activity");
    expect(names).toContain("ingest_document");
    expect(names).toContain("query_memory");
  });

  it("record_activity tool works via MCP protocol", async () => {
    const result = await client.callTool({
      name: "record_activity",
      arguments: { log: "Wrote integration test", theme: "testing" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Recorded");
    expect(content[0].text).toContain("testing");
  });

  it("ingest_document tool works via MCP protocol", async () => {
    const result = await client.callTool({
      name: "ingest_document",
      arguments: { filename: "test.md", content: "# Test\n\nContent." },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("test.md");
  });

  it("query_memory tool works via MCP protocol", async () => {
    const result = await client.callTool({
      name: "query_memory",
      arguments: { query: "testing" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBeDefined();
  });
});
