import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import { rebuildIndex } from "@openpulse/core/dist/search/index-db.js";
import { handleSearchIndex } from "../src/tools/search-index.js";

describe("search_index tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-search-index-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns ranked results for an already-built index", async () => {
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and gizmos.");
    await rebuildIndex(vault);

    const result = await handleSearchIndex(vault, { query: "widgets" });
    expect(result.content[0].text).toContain("widgets-theme");
    expect(result.content[0].text).toContain("Widgets");
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await writeTheme(vault, `theme-${i}`, `## Section ${i}\n\nContent mentioning gadget number ${i}.`);
    }
    await rebuildIndex(vault);

    const result = await handleSearchIndex(vault, { query: "gadget", limit: 2 });
    // Only two theme names should be mentioned in the formatted output.
    const mentioned = [0, 1, 2, 3, 4].filter((i) => result.content[0].text.includes(`theme-${i}`));
    expect(mentioned).toHaveLength(2);
  });

  it("rebuilds the index once and retries when it's empty, then finds results", async () => {
    // Theme written to disk but index never built — first query attempt is empty.
    await writeTheme(vault, "fresh-theme", "## Fresh\n\nBrand new gadget content here.");

    const result = await handleSearchIndex(vault, { query: "gadget" });
    expect(result.content[0].text).toContain("fresh-theme");
  });

  it("returns a helpful message when the index is empty even after a rebuild attempt", async () => {
    const result = await handleSearchIndex(vault, { query: "nonexistent-term-zzz" });
    expect(result.content[0].text).toMatch(/no (results|matches)/i);
  });
});
