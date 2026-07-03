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

  it("lists all core tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("record_activity");
    expect(names).toContain("ingest_document");
    expect(names).toContain("query_memory");
    expect(names).toContain("submit_update");
    expect(names).toContain("search_index");
    expect(names).toContain("read_theme");
  });

  it("submit_update tool description marks it deprecated in favor of record_activity", async () => {
    const { tools } = await client.listTools();
    const submitUpdate = tools.find((t) => t.name === "submit_update");
    expect(submitUpdate?.description).toMatch(/deprecated/i);
    expect(submitUpdate?.description).toContain("record_activity");
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

  it("search_index tool works via MCP protocol", async () => {
    const result = await client.callTool({
      name: "search_index",
      arguments: { query: "testing" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBeDefined();
  });

  it("read_theme tool works via MCP protocol", async () => {
    const result = await client.callTool({
      name: "read_theme",
      arguments: { theme: "nonexistent" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toMatch(/not found/i);
  });

  it("exposes the wiki index as an MCP resource", async () => {
    const { resources } = await client.listResources();
    const indexResource = resources.find((r) => r.uri === "openpulse://index");
    expect(indexResource).toBeDefined();

    const { contents } = await client.readResource({ uri: "openpulse://index" });
    expect(contents[0].mimeType).toBe("text/markdown");
    expect(typeof contents[0].text).toBe("string");
  });

  it("registers the summarize_my_week and what_do_i_know_about prompts", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("summarize_my_week");
    expect(names).toContain("what_do_i_know_about");

    const whatDoIKnow = prompts.find((p) => p.name === "what_do_i_know_about");
    expect(whatDoIKnow?.arguments?.map((a) => a.name)).toContain("topic");
  });

  it("what_do_i_know_about prompt returns imperative guidance mentioning the topic", async () => {
    const result = await client.getPrompt({
      name: "what_do_i_know_about",
      arguments: { topic: "authentication" },
    });
    const text = result.messages.map((m: any) => m.content.text).join(" ");
    expect(text).toContain("authentication");
    expect(text).toMatch(/search_index/);
    expect(text).toMatch(/read_theme/);
  });

  it("summarize_my_week prompt instructs use of search_index/read_theme and log.md", async () => {
    const result = await client.getPrompt({ name: "summarize_my_week" });
    const text = result.messages.map((m: any) => m.content.text).join(" ");
    expect(text).toMatch(/search_index/);
    expect(text).toMatch(/read_theme/);
    expect(text).toMatch(/log\.md/);
  });
});
