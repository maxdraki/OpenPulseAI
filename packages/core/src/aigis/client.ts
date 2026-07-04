/**
 * Outbound MCP client for aigis.bio's remote MCP server.
 *
 * OpenPulseAI's second purpose is a proof-of-work journal for aigis.bio (the
 * user's candidate-knowledge product). This module is the foundation for
 * connecting to it: a per-call client that lists tools (for the Settings
 * "Test connection" flow) and calls an arbitrary named tool with JSON args
 * (for later scheduled rollups and submit-on-approval work).
 *
 * Posture: nothing here ever throws to a caller that didn't opt in — every
 * public function returns a structured result. Connections are per-call
 * (connect -> do the thing -> close); there's no long-lived client state to
 * manage or leak.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AigisConfig } from "../types.js";

/** A dead/unreachable endpoint must not hang callers indefinitely. */
const CONNECT_TIMEOUT_MS = 30_000;

export interface AigisTestResult {
  ok: boolean;
  tools: string[];
  hasSubmitTool: boolean;
  error?: string;
}

export interface AigisToolCallResult {
  ok: boolean;
  content?: unknown;
  error?: string;
  /** True when the failure happened at the transport/connection layer rather than inside the tool call itself. */
  transportError?: boolean;
}

function buildTransport(config: Pick<AigisConfig, "endpoint" | "authToken">): StreamableHTTPClientTransport {
  const headers: Record<string, string> = {};
  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }
  return new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Connects to the configured Aigis MCP server, lists its tools, and reports
 * whether the configured submit tool is present. Never throws — connection,
 * auth, and timeout failures all come back as `{ ok: false, error }`.
 */
export async function testAigisConnection(
  config: AigisConfig,
  timeoutMs: number = CONNECT_TIMEOUT_MS
): Promise<AigisTestResult> {
  const client = new Client({ name: "openpulse-aigis-client", version: "0.1.0" });
  const transport = buildTransport(config);

  try {
    await withTimeout(client.connect(transport), timeoutMs, "Connection to Aigis timed out");
    const result = await withTimeout(client.listTools(), timeoutMs, "Listing Aigis tools timed out");
    const tools = result.tools.map((t) => t.name);
    return {
      ok: true,
      tools,
      hasSubmitTool: tools.includes(config.submitTool),
    };
  } catch (error: any) {
    return {
      ok: false,
      tools: [],
      hasSubmitTool: false,
      error: error?.message ?? String(error),
    };
  } finally {
    await client.close().catch(() => { /* already closed / never connected */ });
  }
}

/**
 * Connects to the configured Aigis MCP server and calls `toolName` with
 * `args`. Returns the tool's result content on success. Distinguishes
 * transport-layer failures (couldn't connect, auth rejected, timed out) from
 * tool-level failures (the tool ran and reported an error) via
 * `transportError`. Never throws.
 */
export async function callAigisTool(
  config: AigisConfig,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = CONNECT_TIMEOUT_MS
): Promise<AigisToolCallResult> {
  const client = new Client({ name: "openpulse-aigis-client", version: "0.1.0" });
  const transport = buildTransport(config);

  try {
    await withTimeout(client.connect(transport), timeoutMs, "Connection to Aigis timed out");

    let result;
    try {
      result = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        timeoutMs,
        "Aigis tool call timed out"
      );
    } catch (error: any) {
      return { ok: false, error: error?.message ?? String(error), transportError: true };
    }

    if (result.isError) {
      const message = Array.isArray(result.content) && result.content[0]?.type === "text"
        ? result.content[0].text
        : "Tool reported an error";
      return { ok: false, error: message, content: result.content, transportError: false };
    }

    return { ok: true, content: result.content };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error), transportError: true };
  } finally {
    await client.close().catch(() => { /* already closed / never connected */ });
  }
}
