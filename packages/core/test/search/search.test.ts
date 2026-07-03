import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import { writeTheme } from "../../src/warm.js";
import { rebuildIndex } from "../../src/search/index-db.js";
import { searchIndex } from "../../src/search/search.js";

describe("searchIndex", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-search-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns [] for an empty query", async () => {
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");
    await rebuildIndex(vault);

    expect(await searchIndex(vault, "")).toEqual([]);
    expect(await searchIndex(vault, "   ")).toEqual([]);
  });

  it("returns [] when there are no matches", async () => {
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");
    await rebuildIndex(vault);

    expect(await searchIndex(vault, "zzz-nonexistent-term-zzz")).toEqual([]);
  });

  it("a query containing FTS5 syntax (quotes, AND) does not throw", async () => {
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");
    await rebuildIndex(vault);

    await expect(searchIndex(vault, 'widgets AND "weird" OR (x)')).resolves.toBeDefined();
  });

  it("ranks a doc mentioning the query term in its heading above a doc mentioning it only in the body", async () => {
    await writeTheme(
      vault,
      "widgets-theme",
      "## Widgets\n\nThis section is the canonical place for widget-related notes."
    );
    await writeTheme(
      vault,
      "other-theme",
      "## Unrelated Heading\n\nThis section mentions widgets only once in passing, deep in the body text."
    );
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "widgets");
    expect(results.length).toBeGreaterThanOrEqual(2);

    const headingHitRank = results.find((r) => r.theme === "widgets-theme")!.rank;
    const bodyOnlyHitRank = results.find((r) => r.theme === "other-theme")!.rank;
    expect(headingHitRank).toBeLessThan(bodyOnlyHitRank);
  });

  it("assigns 1-based sequential ranks in score order", async () => {
    await writeTheme(vault, "a", "## Foo\n\nRepeated term term term term term term term.");
    await writeTheme(vault, "b", "## Bar\n\nOne mention of term here.");
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "term");
    expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
  });

  it("returns snippet, score, theme, heading fields", async () => {
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets and gizmos.");
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "widgets");
    expect(results).toHaveLength(1);
    expect(results[0].theme).toBe("a");
    expect(results[0].heading).toBe("Section");
    expect(typeof results[0].snippet).toBe("string");
    expect(typeof results[0].score).toBe("number");
  });

  it("respects opts.limit", async () => {
    for (let i = 0; i < 5; i++) {
      await writeTheme(vault, `theme-${i}`, `## Section ${i}\n\nContent mentioning gadget number ${i} here.`);
    }
    await rebuildIndex(vault);

    const results = await searchIndex(vault, "gadget", { limit: 2 });
    expect(results).toHaveLength(2);
  });
});
