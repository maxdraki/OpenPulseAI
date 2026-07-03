/**
 * Bearer-token auth for the MCP HTTPS transport (http.ts).
 *
 * Extracted into its own module (rather than inlined in http.ts) so the token
 * generation/persistence and request-authorization logic can be unit tested
 * without spinning up an HTTPS server.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

/** Token file lives in the config dir (same dir as config.yaml), NOT the vault —
 *  it's a machine credential, not vault data, so it shouldn't be git-tracked or
 *  travel with vault backups/exports. */
export const TOKEN_FILE_NAME = "mcp-token";

/** 32 random bytes -> 64 hex chars, comfortably over the 32+ hex char minimum. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time string compare (avoids leaking the token via timing). */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function tokenPath(configDir: string): string {
  return join(configDir, TOKEN_FILE_NAME);
}

/**
 * Load the persisted MCP bearer token from the config dir, generating and
 * persisting a new one (mode 0600) on first run. Concurrent first-run callers
 * (unlikely — this only runs once at server startup) could each generate a
 * token and race on the write; last writer wins, which is safe (both are
 * valid random tokens, only one is ever the ground truth on disk after that).
 */
export async function loadOrCreateToken(configDir: string): Promise<string> {
  const path = tokenPath(configDir);
  try {
    const existing = (await readFile(path, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    /* not yet created */
  }

  const token = generateToken();
  await mkdir(configDir, { recursive: true });
  await writeFile(path, token + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  return token;
}

/**
 * Extracts the bearer token from a request: an `Authorization: Bearer <token>`
 * header, or a `?token=` query param. Claude Desktop's "Add custom connector"
 * dialog only accepts a URL (no custom headers), so a token embedded in the
 * URL is the practical path for that flow; the header form is for callers
 * that can set one (curl, other MCP clients).
 */
export function extractRequestToken(req: Pick<IncomingMessage, "headers" | "url">): string {
  const authHeader = req.headers.authorization ?? "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);

  const url = req.url ?? "";
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return "";
  const params = new URLSearchParams(url.slice(qIndex + 1));
  return params.get("token") ?? "";
}

/** True iff the request carries a token that matches `expectedToken`. An empty
 *  expectedToken never authorizes anything — the HTTPS transport must always
 *  have a token configured (unlike the UI dev-server's opt-in guard). */
export function isAuthorized(req: Pick<IncomingMessage, "headers" | "url">, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const provided = extractRequestToken(req);
  return provided.length > 0 && tokensMatch(provided, expectedToken);
}

/** Strips the query string, for matching the request path (`/mcp` vs `/mcp?token=...`). */
export function requestPathname(url: string | undefined): string {
  const raw = url ?? "";
  const qIndex = raw.indexOf("?");
  return qIndex === -1 ? raw : raw.slice(0, qIndex);
}
