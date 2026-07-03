import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "../../core/dist/index.js";
import { searchThemesForApi } from "../server.js";

describe("searchThemesForApi (backs GET /api/search)", () => {
  let tempDir: string;
  let vault: Vault;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-api-search-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns no results for a blank query without touching the vault", async () => {
    expect(await searchThemesForApi(tempDir, "")).toEqual([]);
    expect(await searchThemesForApi(tempDir, "   ")).toEqual([]);
  });

  it("returns ranked results (theme, heading, snippet) for a matching query", async () => {
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and gizmos.");

    const results = await searchThemesForApi(tempDir, "widgets");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ theme: "widgets-theme" });
    expect(results[0].heading).toBeTruthy();
    expect(results[0].snippet).toBeTruthy();
  });

  it("rebuilds the index once and retries when it's empty, then finds results", async () => {
    // Theme written to disk but index never built — first attempt is empty.
    await writeTheme(vault, "fresh-theme", "## Fresh\n\nBrand new gadget content here.");

    const results = await searchThemesForApi(tempDir, "gadget");
    expect(results.some((r) => r.theme === "fresh-theme")).toBe(true);
  });

  it("returns an empty array when nothing matches, even after a rebuild attempt", async () => {
    const results = await searchThemesForApi(tempDir, "nonexistent-term-zzz");
    expect(results).toEqual([]);
  });
});
