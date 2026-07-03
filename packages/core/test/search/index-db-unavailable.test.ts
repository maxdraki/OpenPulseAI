import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This file is isolated from index-db.test.ts (separate module graph per
// vitest test file) so mocking "node:sqlite" here never leaks into the
// happy-path tests, which rely on the real module. Mirrors the pattern in
// vault-git-missing.test.ts for a different one-time-latched dependency.
vi.mock("node:sqlite", () => {
  throw new Error("node:sqlite is not available in this simulated environment");
});

describe("search index-db — graceful degradation when node:sqlite is unavailable", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-search-index-unavailable-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rebuildIndex never throws and no-ops when node:sqlite is unavailable", async () => {
    const { Vault } = await import("../../src/vault.js");
    const { writeTheme } = await import("../../src/warm.js");
    const { rebuildIndex } = await import("../../src/search/index-db.js");

    const vault = new Vault(tempDir);
    await vault.init();
    await writeTheme(vault, "a", "## Section\n\nSome content.");

    await expect(rebuildIndex(vault)).resolves.toBeUndefined();
  });

  it("searchIndex returns [] (never throws) when node:sqlite is unavailable", async () => {
    const { Vault } = await import("../../src/vault.js");
    const { writeTheme } = await import("../../src/warm.js");
    const { searchIndex } = await import("../../src/search/search.js");

    const vault = new Vault(tempDir);
    await vault.init();
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");

    await expect(searchIndex(vault, "widgets")).resolves.toEqual([]);
  });

  it("warns only once across many calls (per-process latch)", async () => {
    const { Vault } = await import("../../src/vault.js");
    const { rebuildIndex, updateThemeInIndex } = await import("../../src/search/index-db.js");

    const vault = new Vault(tempDir);
    await vault.init();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await rebuildIndex(vault);
      await updateThemeInIndex(vault, "a");
      await rebuildIndex(vault);

      const unavailableWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("node:sqlite unavailable")
      );
      expect(unavailableWarnings.length).toBeLessThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
