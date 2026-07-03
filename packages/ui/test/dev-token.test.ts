import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateToken,
  tokensMatch,
  loadOrCreateToken,
  tokenPath,
  isAuthorizedHeader,
} from "../dev-token.js";

describe("generateToken", () => {
  it("generates a 64-char hex string", () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different token each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("tokensMatch", () => {
  it("matches identical strings", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  it("rejects different-length strings", () => {
    expect(tokensMatch("short", "muchlongerstring")).toBe(false);
  });
});

describe("loadOrCreateToken", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-ui-token-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("generates and persists a token on first call", async () => {
    const token = await loadOrCreateToken(tempDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = (await readFile(tokenPath(tempDir), "utf-8")).trim();
    expect(onDisk).toBe(token);
  });

  it("persists the token file with mode 0600", async () => {
    await loadOrCreateToken(tempDir);
    const st = await stat(tokenPath(tempDir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("reuses an existing token rather than regenerating (server.ts and vite.config.ts share one)", async () => {
    const first = await loadOrCreateToken(tempDir);
    const second = await loadOrCreateToken(tempDir);
    expect(second).toBe(first);
  });
});

describe("isAuthorizedHeader — the dev-server's default-on bearer guard", () => {
  const expected = "the-real-token";

  it("authorizes a matching bearer header", () => {
    expect(isAuthorizedHeader(`Bearer ${expected}`, expected)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isAuthorizedHeader(undefined, expected)).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorizedHeader("Bearer wrong-token", expected)).toBe(false);
  });

  it("rejects a header without the Bearer prefix", () => {
    expect(isAuthorizedHeader(expected, expected)).toBe(false);
  });

  // This is the crux of the item-6 fix: previously an unset/empty expected
  // token meant "the guard is off, let everything through". Now the guard is
  // always on (server.ts always sources a real token — env var or
  // auto-generated file), but the pure helper itself must also never treat an
  // empty expected token as "anything goes", so a future caller can't
  // accidentally reintroduce the open-by-default hole.
  it("never authorizes when no expected token is configured", () => {
    expect(isAuthorizedHeader(`Bearer ${expected}`, "")).toBe(false);
  });
});
