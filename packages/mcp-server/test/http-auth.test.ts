import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateToken,
  tokensMatch,
  loadOrCreateToken,
  tokenPath,
  extractRequestToken,
  isAuthorized,
  requestPathname,
} from "../src/http-auth.js";

describe("generateToken", () => {
  it("generates a 64-char hex string (32+ bytes of entropy)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different token each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("tokensMatch", () => {
  it("returns true for identical strings", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings (no length-leak shortcut)", () => {
    expect(tokensMatch("short", "muchlongerstring")).toBe(false);
  });
});

describe("loadOrCreateToken", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-token-"));
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

  it("returns the SAME token on subsequent calls (doesn't regenerate)", async () => {
    const first = await loadOrCreateToken(tempDir);
    const second = await loadOrCreateToken(tempDir);
    expect(second).toBe(first);
  });
});

describe("extractRequestToken", () => {
  it("reads from an Authorization: Bearer header", () => {
    const req = { headers: { authorization: "Bearer sekret123" }, url: "/mcp" };
    expect(extractRequestToken(req)).toBe("sekret123");
  });

  it("reads from a ?token= query param when no header is present", () => {
    const req = { headers: {}, url: "/mcp?token=sekret123" };
    expect(extractRequestToken(req)).toBe("sekret123");
  });

  it("prefers the header over the query param when both are present", () => {
    const req = { headers: { authorization: "Bearer from-header" }, url: "/mcp?token=from-query" };
    expect(extractRequestToken(req)).toBe("from-header");
  });

  it("returns empty string when neither is present", () => {
    const req = { headers: {}, url: "/mcp" };
    expect(extractRequestToken(req)).toBe("");
  });
});

describe("isAuthorized", () => {
  const expected = "correct-token-value";

  it("authorizes a matching bearer header", () => {
    const req = { headers: { authorization: `Bearer ${expected}` }, url: "/mcp" };
    expect(isAuthorized(req, expected)).toBe(true);
  });

  it("authorizes a matching query-param token", () => {
    const req = { headers: {}, url: `/mcp?token=${expected}` };
    expect(isAuthorized(req, expected)).toBe(true);
  });

  it("rejects a missing token", () => {
    const req = { headers: {}, url: "/mcp" };
    expect(isAuthorized(req, expected)).toBe(false);
  });

  it("rejects a wrong token", () => {
    const req = { headers: { authorization: "Bearer wrong" }, url: "/mcp" };
    expect(isAuthorized(req, expected)).toBe(false);
  });

  it("never authorizes when no expected token is configured (no open-by-default fallback)", () => {
    const req = { headers: { authorization: `Bearer ${expected}` }, url: "/mcp" };
    expect(isAuthorized(req, "")).toBe(false);
  });
});

describe("requestPathname", () => {
  it("strips the query string", () => {
    expect(requestPathname("/mcp?token=abc")).toBe("/mcp");
  });

  it("returns the url unchanged when there's no query string", () => {
    expect(requestPathname("/mcp")).toBe("/mcp");
  });

  it("returns empty string for undefined", () => {
    expect(requestPathname(undefined)).toBe("");
  });
});
