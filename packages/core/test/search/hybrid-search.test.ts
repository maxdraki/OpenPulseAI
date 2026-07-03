import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import { writeTheme } from "../../src/warm.js";
import { rebuildIndex } from "../../src/search/index-db.js";
import { searchIndex } from "../../src/search/search.js";
import { setEmbedderForTests } from "../../src/search/embeddings.js";

/** A fake embedder that assigns hand-picked vectors by recognizable
 *  substrings, so tests can force specific cosine-similarity relationships
 *  without any real model. Unrecognized text gets a neutral zero vector. */
function vectorFor(text: string): Float32Array {
  const lower = text.toLowerCase();
  if (lower.includes("astrophysics") || lower.includes("cosmology") || lower.includes("space telescope")) {
    return new Float32Array([1, 0, 0]);
  }
  if (lower.includes("widgets")) {
    return new Float32Array([0, 1, 0]);
  }
  return new Float32Array([0, 0, 1]);
}

describe("searchIndex — hybrid FTS + vector ranking", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-hybrid-search-"));
    vault = new Vault(tempDir);
    await vault.init();
    setEmbedderForTests(async (texts) => texts.map(vectorFor));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    setEmbedderForTests(null);
  });

  it("surfaces a vector-only semantic match with zero keyword overlap", async () => {
    await writeTheme(
      vault,
      "cosmology-notes",
      "## Cosmology\n\nNotes about the space telescope and cosmology research."
    );
    await writeTheme(vault, "unrelated", "## Unrelated\n\nSome unrelated content about paperwork.");
    await rebuildIndex(vault);

    // Query embeds to the same vector as the astrophysics theme, but shares
    // no keyword with it at all — FTS alone would return nothing for it.
    const results = await searchIndex(vault, "astrophysics");

    const hit = results.find((r) => r.theme === "cosmology-notes");
    expect(hit).toBeDefined();
    expect(hit!.signals).toContain("vector");
  });

  it("marks a result matched by both signals with both signal names", async () => {
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and their uses.");
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "widgets");
    const hit = results.find((r) => r.theme === "widgets-theme");
    expect(hit).toBeDefined();
    expect(hit!.signals).toEqual(expect.arrayContaining(["fts", "vector"]));
  });

  it("mode: 'fts' skips the vector signal even when embeddings are available", async () => {
    await writeTheme(
      vault,
      "cosmology-notes",
      "## Cosmology\n\nNotes about the space telescope and cosmology research."
    );
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "astrophysics", { mode: "fts" });
    expect(results.find((r) => r.theme === "cosmology-notes")).toBeUndefined();
  });

  it("degrades to FTS-only results (with only the 'fts' signal) when embeddings are unavailable", async () => {
    setEmbedderForTests(null);
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and their uses.");
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "widgets");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.signals).toEqual(["fts"]);
    }
  });

  it("still returns [] for an empty query in hybrid mode", async () => {
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");
    await rebuildIndex(vault);

    expect(await searchIndex(vault, "")).toEqual([]);
  });
});
