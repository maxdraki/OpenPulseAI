import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { testAigisConnection, callAigisTool } from "../src/aigis/client.js";
import type { AigisConfig } from "../src/types.js";

/**
 * Spins up a real, in-process MCP server over Streamable HTTP on a random
 * localhost port, mirroring packages/mcp-server/src/http.ts's transport
 * setup. Used so client tests exercise the real wire protocol rather than a
 * hand-rolled fake.
 */
async function startMockAigisServer(opts?: {
  requireAuth?: string; // if set, requests without this bearer token are rejected
  tools?: Array<{ name: string; handler: (args: any) => any }>;
  neverRespond?: boolean; // simulate a dead/hanging endpoint
}): Promise<{ url: string; close: () => Promise<void>; receivedAuth: string[] }> {
  const receivedAuth: string[] = [];
  const httpServer: HttpServer = createHttpServer();

  if (opts?.neverRespond) {
    httpServer.on("request", (_req: IncomingMessage, _res: ServerResponse) => {
      // Deliberately never respond — exercises the client's timeout path.
    });
  } else {
    const makeServer = () => {
      const mcpServer = new McpServer({ name: "mock-aigis", version: "0.0.1" });
      for (const tool of opts?.tools ?? []) {
        mcpServer.registerTool(
          tool.name,
          { inputSchema: z.record(z.any()) },
          async (input: any) => tool.handler(input)
        );
      }
      return mcpServer;
    };

    // Stateless mode (sessionIdGenerator: undefined) requires a fresh
    // transport + server per request — the SDK's own stateless example
    // (examples/server/simpleStatelessStreamableHttp.ts) does the same; a
    // shared transport instance rejects the second request with "Stateless
    // transport cannot be reused across requests."
    httpServer.on("request", async (req: IncomingMessage, res: ServerResponse) => {
      receivedAuth.push(req.headers.authorization ?? "");
      if (opts?.requireAuth) {
        const expected = `Bearer ${opts.requireAuth}`;
        if (req.headers.authorization !== expected) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
          return;
        }
      }
      const mcpServer = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });
    });
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    receivedAuth,
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

function makeConfig(endpoint: string, overrides: Partial<AigisConfig> = {}): AigisConfig {
  return {
    endpoint,
    submitTool: "aigis_submit_journal",
    enabled: true,
    ...overrides,
  };
}

describe("testAigisConnection", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("returns ok:true with the tool list on a healthy connection", async () => {
    const server = await startMockAigisServer({
      tools: [{ name: "aigis_submit_journal", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
    });
    cleanup = server.close;

    const result = await testAigisConnection(makeConfig(server.url));

    expect(result.ok).toBe(true);
    expect(result.tools).toContain("aigis_submit_journal");
    expect(result.hasSubmitTool).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("reports hasSubmitTool:false when the configured submit tool is missing", async () => {
    const server = await startMockAigisServer({
      tools: [{ name: "some_other_tool", handler: () => ({ content: [] }) }],
    });
    cleanup = server.close;

    const result = await testAigisConnection(makeConfig(server.url, { submitTool: "aigis_submit_journal" }));

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual(["some_other_tool"]);
    expect(result.hasSubmitTool).toBe(false);
  });

  it("sends the bearer token from authToken as an Authorization header", async () => {
    const server = await startMockAigisServer({
      requireAuth: "sekret-123",
      tools: [{ name: "aigis_submit_journal", handler: () => ({ content: [] }) }],
    });
    cleanup = server.close;

    const result = await testAigisConnection(makeConfig(server.url, { authToken: "sekret-123" }));

    expect(result.ok).toBe(true);
    expect(server.receivedAuth).toContain("Bearer sekret-123");
  });

  it("fails with a structured error when the auth token is wrong", async () => {
    const server = await startMockAigisServer({
      requireAuth: "correct-token",
      tools: [{ name: "aigis_submit_journal", handler: () => ({ content: [] }) }],
    });
    cleanup = server.close;

    const result = await testAigisConnection(makeConfig(server.url, { authToken: "wrong-token" }));

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("never throws and reports a timeout when the endpoint never responds", async () => {
    const server = await startMockAigisServer({ neverRespond: true });
    cleanup = server.close;

    const result = await testAigisConnection(makeConfig(server.url), 200);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("never throws and reports a structured error for an unreachable endpoint", async () => {
    // Nothing is listening on this port.
    const result = await testAigisConnection(makeConfig("https://127.0.0.1:1"), 1000);

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.hasSubmitTool).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("callAigisTool", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("returns ok:true with the tool's content on a successful call", async () => {
    const server = await startMockAigisServer({
      tools: [{
        name: "aigis_submit_journal",
        handler: (input: any) => ({ content: [{ type: "text", text: `received:${JSON.stringify(input)}` }] }),
      }],
    });
    cleanup = server.close;

    const result = await callAigisTool(makeConfig(server.url), "aigis_submit_journal", { rollup: "week-1" });

    expect(result.ok).toBe(true);
    expect(result.transportError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("week-1");
  });

  it("distinguishes a tool-level error from a transport error", async () => {
    const server = await startMockAigisServer({
      tools: [{
        name: "aigis_submit_journal",
        handler: () => ({ content: [{ type: "text", text: "validation failed" }], isError: true }),
      }],
    });
    cleanup = server.close;

    const result = await callAigisTool(makeConfig(server.url), "aigis_submit_journal", {});

    expect(result.ok).toBe(false);
    expect(result.transportError).toBe(false);
    expect(result.error).toMatch(/validation failed/);
  });

  it("marks a connection failure as a transport error", async () => {
    const result = await callAigisTool(makeConfig("https://127.0.0.1:1"), "aigis_submit_journal", {}, 1000);

    expect(result.ok).toBe(false);
    expect(result.transportError).toBe(true);
  });

  it("never hangs — reports a timeout for a dead endpoint", async () => {
    const server = await startMockAigisServer({ neverRespond: true });
    cleanup = server.close;

    const result = await callAigisTool(makeConfig(server.url), "aigis_submit_journal", {}, 200);

    expect(result.ok).toBe(false);
    expect(result.transportError).toBe(true);
    expect(result.error).toMatch(/timed out/i);
  });
});
