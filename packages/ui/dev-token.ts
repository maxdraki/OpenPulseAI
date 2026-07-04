/**
 * Auto-generated, persisted bearer token shared by the UI dev API server
 * (server.ts) and its vite dev-server counterpart (vite.config.ts).
 *
 * Both processes need the SAME token so the browser bundle (built by vite,
 * which embeds it as `import.meta.env.VITE_OPENPULSE_TOKEN`) can authenticate
 * against the API server. Whichever of the two starts first generates and
 * persists the token; the other just reads it.
 *
 * Lives in the config dir (~/OpenPulseAI/), NOT the git-backed vault/ subtree —
 * it's a machine credential, not vault data.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";

export const TOKEN_FILE_NAME = "ui-token";

/** `explicitPath`, when given, is used verbatim instead of deriving the path
 *  from `configDir` — lets tests (and startServer's `tokenPath` option)
 *  point at an isolated token file without touching the real config dir. */
export function tokenPath(configDir: string, explicitPath?: string): string {
  return explicitPath ?? join(configDir, TOKEN_FILE_NAME);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Loads the persisted token, generating and persisting one (mode 0600) if
 * none exists yet. Called from BOTH server.ts and vite.config.ts — it's
 * idempotent (checks the file first), so whichever of the two dev processes
 * starts first creates it and the other just reads it; there's no required
 * startup ordering between `npx tsx server.ts` and `npx vite`.
 */
export async function loadOrCreateToken(configDir: string, explicitPath?: string): Promise<string> {
  const path = tokenPath(configDir, explicitPath);
  try {
    const existing = (await readFile(path, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    /* not yet created */
  }

  const token = generateToken();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  return token;
}

/** Constant-time string compare (avoids leaking the token via timing) —
 *  matching the tokensMatch idiom already used elsewhere in server.ts. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Pure guard-logic check: does this `Authorization` header value carry a
 * bearer token matching `expectedToken`? Extracted out of the inline Express
 * middleware in server.ts so it's unit-testable without booting the app.
 * An empty expectedToken never authorizes anything (no open-by-default
 * fallback — that's the whole point of this hardening pass).
 */
export function isAuthorizedHeader(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const header = authHeader ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token.length > 0 && tokensMatch(token, expectedToken);
}
