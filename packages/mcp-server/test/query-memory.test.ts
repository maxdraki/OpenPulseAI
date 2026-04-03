import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import { handleQueryMemory } from "../src/tools/query-memory.js";

describe("query_memory tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns no results when vault is empty", async () => {
    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("No thematic summaries found");
  });

  it("finds matching themes", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    await writeTheme(vault, "project-ui", "## UI\n\nReact components and styling.");

    const result = await handleQueryMemory(vault, { query: "authentication login" });
    expect(result.content[0].text).toContain("project-auth");
    expect(result.content[0].text).not.toContain("project-ui");
  });

  it("returns all themes when query matches multiple", async () => {
    await writeTheme(vault, "backend", "## Backend\n\nNode.js authentication and API routes.");
    await writeTheme(vault, "frontend", "## Frontend\n\nReact components for authentication.");

    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("backend");
    expect(result.content[0].text).toContain("frontend");
  });

  it("ranks more relevant themes first", async () => {
    await writeTheme(vault, "auth-deep", "## Auth\n\nAuthentication, login, auth tokens, auth middleware.");
    await writeTheme(vault, "misc", "## Misc\n\nSome authentication notes.");

    const result = await handleQueryMemory(vault, { query: "authentication auth" });
    const text = result.content[0].text;
    expect(text.indexOf("auth-deep")).toBeLessThan(text.indexOf("misc"));
  });
});
