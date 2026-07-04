import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load as loadYaml } from "js-yaml";
import { readAigisConfigForApi, saveAigisConfigForApi, readAigisLastSubmissionForApi } from "../server.js";

describe("readAigisConfigForApi (backs GET /api/aigis-config)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-aigis-api-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns disabled defaults when no config file exists", async () => {
    const result = await readAigisConfigForApi(tempDir);
    expect(result).toMatchObject({ endpoint: "", enabled: false, hasToken: false, submitTool: "aigis_submit_journal" });
  });

  it("returns the masked token, never the raw one", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: https://aigis.bio/mcp\n  authToken: super-secret-token-value\n  enabled: true\n`,
      "utf-8"
    );

    const result = await readAigisConfigForApi(tempDir);
    expect(result.endpoint).toBe("https://aigis.bio/mcp");
    expect(result.enabled).toBe(true);
    expect(result.hasToken).toBe(true);
    expect((result as any).authToken).toBeUndefined();
    expect(result.tokenHint).not.toContain("super-secret-token-value");
  });
});

describe("saveAigisConfigForApi (backs POST /api/aigis-config)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-aigis-api-save-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writes a fresh aigis section", async () => {
    await saveAigisConfigForApi(tempDir, {
      endpoint: "https://aigis.bio/mcp",
      authToken: "token-1",
      submitTool: "aigis_submit_journal",
      enabled: true,
    });

    const raw = await readFile(join(tempDir, "config.yaml"), "utf-8");
    const parsed = loadYaml(raw) as any;
    expect(parsed.aigis).toEqual({
      endpoint: "https://aigis.bio/mcp",
      authToken: "token-1",
      submitTool: "aigis_submit_journal",
      enabled: true,
    });
  });

  it("keeps the existing token when a blank token is submitted", async () => {
    await saveAigisConfigForApi(tempDir, {
      endpoint: "https://aigis.bio/mcp",
      authToken: "original-token",
      enabled: true,
    });

    await saveAigisConfigForApi(tempDir, {
      endpoint: "https://aigis.bio/mcp",
      authToken: "",
      enabled: true,
    });

    const raw = await readFile(join(tempDir, "config.yaml"), "utf-8");
    const parsed = loadYaml(raw) as any;
    expect(parsed.aigis.authToken).toBe("original-token");
  });

  it("overwrites the token when a new one is submitted", async () => {
    await saveAigisConfigForApi(tempDir, { endpoint: "https://aigis.bio/mcp", authToken: "old", enabled: true });
    await saveAigisConfigForApi(tempDir, { endpoint: "https://aigis.bio/mcp", authToken: "new", enabled: true });

    const raw = await readFile(join(tempDir, "config.yaml"), "utf-8");
    const parsed = loadYaml(raw) as any;
    expect(parsed.aigis.authToken).toBe("new");
  });

  it("preserves themes and llm sections already in config.yaml", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `themes:\n  - project-auth\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-5-20250929\n`,
      "utf-8"
    );

    await saveAigisConfigForApi(tempDir, { endpoint: "https://aigis.bio/mcp", enabled: true });

    const raw = await readFile(join(tempDir, "config.yaml"), "utf-8");
    const parsed = loadYaml(raw) as any;
    expect(parsed.themes).toEqual(["project-auth"]);
    expect(parsed.llm).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
    expect(parsed.aigis.endpoint).toBe("https://aigis.bio/mcp");
  });

  it("defaults submitTool to aigis_submit_journal when not provided", async () => {
    await saveAigisConfigForApi(tempDir, { endpoint: "https://aigis.bio/mcp", enabled: true });

    const raw = await readFile(join(tempDir, "config.yaml"), "utf-8");
    const parsed = loadYaml(raw) as any;
    expect(parsed.aigis.submitTool).toBe("aigis_submit_journal");
  });
});

describe("readAigisLastSubmissionForApi (backs GET /api/aigis-last-submission)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-aigis-last-submission-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns found:false without creating any vault directories (fix round 1 #5 — no Vault.init() side effects)", async () => {
    const result = await readAigisLastSubmissionForApi(tempDir);
    expect(result).toEqual({ found: false });

    // The whole point: a read-only status check must not mkdir the vault
    // tree (hot/warm/pending/cold/sessions/aigis) or adopt a git repo, which
    // Vault.init() does unconditionally.
    await expect(stat(join(tempDir, "vault"))).rejects.toThrow();
  });

  it("returns the last JSONL line, spread onto found:true", async () => {
    await mkdir(join(tempDir, "vault", "aigis"), { recursive: true });
    await writeFile(
      join(tempDir, "vault", "aigis", "submissions.jsonl"),
      [
        JSON.stringify({ updateId: "u1", theme: "t1", ok: false, error: "boom", submittedAt: "2026-06-01T00:00:00.000Z", toolName: "aigis_submit_journal" }),
        JSON.stringify({ updateId: "u2", theme: "t2", ok: true, submittedAt: "2026-06-02T00:00:00.000Z", toolName: "aigis_submit_journal" }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const result = await readAigisLastSubmissionForApi(tempDir);
    expect(result).toMatchObject({ found: true, updateId: "u2", theme: "t2", ok: true });
  });

  it("treats a malformed last line as found:false rather than throwing", async () => {
    await mkdir(join(tempDir, "vault", "aigis"), { recursive: true });
    await writeFile(join(tempDir, "vault", "aigis", "submissions.jsonl"), "not json\n", "utf-8");

    const result = await readAigisLastSubmissionForApi(tempDir);
    expect(result).toEqual({ found: false });
  });
});
