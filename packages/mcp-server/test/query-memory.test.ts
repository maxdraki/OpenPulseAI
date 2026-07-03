import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme, rebuildIndex } from "@openpulse/core";
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

  it("finds matching themes via ranked chunks, grouped by theme", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    await writeTheme(vault, "project-ui", "## UI\n\nReact components and styling.");

    const result = await handleQueryMemory(vault, { query: "authentication login" });
    expect(result.content[0].text).toContain("project-auth");
    expect(result.content[0].text).not.toContain("project-ui");
  });

  it("returns ranked chunks — heading and snippet, not the whole concatenated theme file", async () => {
    await writeTheme(
      vault,
      "backend",
      "## Auth Flow\n\nNode.js authentication and API routes.\n\n## Unrelated Section\n\nSomething about deployment pipelines that shouldn't match."
    );

    const result = await handleQueryMemory(vault, { query: "authentication" });
    const text = result.content[0].text;
    expect(text).toContain("## backend");
    expect(text).toContain("Auth Flow");
    // Ranked-chunk format, not a dump of the whole page.
    expect(text).not.toContain("deployment pipelines");
  });

  it("returns all themes when query matches multiple", async () => {
    await writeTheme(vault, "backend", "## Backend\n\nNode.js authentication and API routes.");
    await writeTheme(vault, "frontend", "## Frontend\n\nReact components for authentication.");

    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("backend");
    expect(result.content[0].text).toContain("frontend");
  });

  it("ranks more relevant themes first", async () => {
    // Same rough document length, but "widget" repeats in one and appears
    // only once in the other — bm25 should rank the higher-frequency match
    // first. (A single shared term is used deliberately: the index ANDs
    // multi-term queries together — see sanitizeFtsQuery — so this isn't
    // testing recall, just relative ranking of two genuine matches.)
    await writeTheme(vault, "auth-deep", "## Auth\n\nWidget widget widget appear here for testing ranking purposes on this page today.");
    await writeTheme(vault, "misc", "## Misc\n\nWidget appears here once for testing ranking purposes on this page today.");

    const result = await handleQueryMemory(vault, { query: "widget" });
    const text = result.content[0].text;
    expect(text.indexOf("auth-deep")).toBeLessThan(text.indexOf("misc"));
  });

  it("rebuilds the index once and retries when it's empty, then finds results", async () => {
    // Theme written to disk but index never built — first query attempt is empty.
    await writeTheme(vault, "fresh-theme", "## Fresh\n\nBrand new gadget content here.");

    const result = await handleQueryMemory(vault, { query: "gadget" });
    expect(result.content[0].text).toContain("fresh-theme");
  });

  it("works against an already-built index too", async () => {
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and gizmos.");
    await rebuildIndex(vault);

    const result = await handleQueryMemory(vault, { query: "widgets" });
    expect(result.content[0].text).toContain("widgets-theme");
  });
});
