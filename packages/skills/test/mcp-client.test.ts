import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SourceMcpClient } from "../src/mcp-client.js";

describe("SourceMcpClient", () => {
  let mcpServer: McpServer;

  beforeEach(() => {
    mcpServer = new McpServer({ name: "test-source", version: "1.0.0" });
    mcpServer.tool("get_emails", "Get recent emails", { limit: z.number() }, async ({ limit }) => ({
      content: [{ type: "text" as const, text: JSON.stringify([{ subject: "Test email", from: "alice@test.com" }]) }],
    }));
  });

  it("connects and lists tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new SourceMcpClient({ name: "test", command: "", args: [], schedule: "", lookback: "24h", enabled: true });
    await client.connectWithTransport(clientTransport);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_emails");
    await client.disconnect();
  });

  it("calls a tool and returns result", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new SourceMcpClient({ name: "test", command: "", args: [], schedule: "", lookback: "24h", enabled: true });
    await client.connectWithTransport(clientTransport);
    const result = await client.callTool("get_emails", { limit: 10 });
    expect(result.content).toBeDefined();
    await client.disconnect();
  });
});
