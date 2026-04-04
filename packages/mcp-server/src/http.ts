#!/usr/bin/env node
/**
 * HTTPS transport for the OpenPulse MCP server.
 * Exposes the same MCP tools over Streamable HTTP so Claude Desktop
 * can connect via the "Add custom connector" dialog with a URL.
 *
 * On first run, generates a self-signed certificate in ~/OpenPulseAI/certs/.
 * You may need to trust this certificate in your OS keychain.
 *
 * Usage: node dist/http.js [--port 3002]
 * Then add https://localhost:3002/mcp as the Remote MCP server URL.
 */
import { createServer } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3002");
const CERTS_DIR = join(VAULT_ROOT, "certs");

function ensureCerts(): { key: Buffer; cert: Buffer } {
  const keyPath = join(CERTS_DIR, "server.key");
  const certPath = join(CERTS_DIR, "server.crt");

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    console.error("[mcp-http] Generating self-signed certificate...");
    mkdirSync(CERTS_DIR, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-nodes",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "pipe" });
    console.error(`[mcp-http] Certificate created at ${CERTS_DIR}`);
    console.error(`[mcp-http] To trust it on macOS, run:`);
    console.error(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`);
  }

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}

async function main() {
  const { server } = await createServer(VAULT_ROOT);
  const { key, cert } = ensureCerts();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const httpsServer = createHttpsServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/mcp") {
      await transport.handleRequest(req, res);
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "openpulse-mcp" }));
    } else {
      res.writeHead(404);
      res.end("Not found. Use /mcp for MCP or /health for health check.");
    }
  });

  httpsServer.listen(PORT, () => {
    console.error(`OpenPulseAI MCP server running on https://localhost:${PORT}/mcp`);
    console.error(`Add this URL as a Remote MCP server in Claude Desktop.`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
