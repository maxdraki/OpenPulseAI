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
import { loadOrCreateToken, isAuthorized, requestPathname, tokenPath } from "./http-auth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3002");
const CERTS_DIR = join(VAULT_ROOT, "certs");
// Token file lives alongside config.yaml (the config dir), not inside the vault —
// it's a machine credential, not vault data.
const CONFIG_DIR = VAULT_ROOT;

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

  // Any local process can otherwise read/write the vault via this port — CORS only
  // restrains browsers, not curl/other local processes. Require a bearer token on
  // every /mcp request. Generated once and persisted (mode 0600) in the config dir
  // so it survives restarts and doesn't need re-entering each time.
  const token = await loadOrCreateToken(CONFIG_DIR);
  console.error(`[mcp-http] Bearer token: ${tokenPath(CONFIG_DIR)} (generated on first run; delete to rotate)`);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const httpsServer = createHttpsServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
    // Restrict CORS to localhost origins only — prevents malicious web pages from
    // reading/writing the vault via a browser pointed at this port.
    // Claude Desktop connects directly (no Origin header) so is unaffected.
    const origin = req.headers.origin ?? "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = requestPathname(req.url);

    if (pathname === "/mcp") {
      if (!isAuthorized(req, token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
          id: null,
        }));
        return;
      }
      await transport.handleRequest(req, res);
    } else if (pathname === "/health") {
      // No vault access, no auth required — used for basic liveness checks.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "openpulse-mcp" }));
    } else {
      res.writeHead(404);
      res.end("Not found. Use /mcp for MCP or /health for health check.");
    }
  });

  httpsServer.listen(PORT, () => {
    const url = `https://localhost:${PORT}/mcp?token=${token}`;
    console.error(`OpenPulseAI MCP server running on ${url}`);
    console.error(`Add this URL (including the token) as a Remote MCP server in Claude Desktop.`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
