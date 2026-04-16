import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import { buildBacklinks, writeBacklinksFile } from "../src/backlinks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function setup() {
  const tempDir = await mkdtemp(join(tmpdir(), "openpulse-backlinks-"));
  const vault = new Vault(tempDir);
  await vault.init();
  return { tempDir, vault };
}

// ---------------------------------------------------------------------------
// buildBacklinks
// ---------------------------------------------------------------------------
describe("buildBacklinks", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty map for empty vault", async () => {
    const result = await buildBacklinks(vault);
    expect(result.size).toBe(0);
  });

  it("single theme with no links: map has key with empty array", async () => {
    await writeTheme(vault, "alpha", "No links here at all.");
    const result = await buildBacklinks(vault);
    expect(result.has("alpha")).toBe(true);
    expect(result.get("alpha")).toEqual([]);
  });

  it("theme A links to theme B: B's inbound list includes A", async () => {
    await writeTheme(vault, "theme-a", "Content that links to [[theme-b]].");
    await writeTheme(vault, "theme-b", "Content with no outbound links.");
    const result = await buildBacklinks(vault);
    expect(result.get("theme-b")).toContain("theme-a");
  });

  it("theme A with link to theme B: A's inbound list is empty", async () => {
    await writeTheme(vault, "theme-a", "Content that links to [[theme-b]].");
    await writeTheme(vault, "theme-b", "Content with no outbound links.");
    const result = await buildBacklinks(vault);
    expect(result.get("theme-a")).toEqual([]);
  });

  it("broken link (link to non-existent theme) is included in map", async () => {
    await writeTheme(vault, "theme-a", "Links to [[nonexistent-theme]].");
    const result = await buildBacklinks(vault);
    // Broken link target should appear in the map
    expect(result.has("nonexistent-theme")).toBe(true);
    expect(result.get("nonexistent-theme")).toContain("theme-a");
  });

  it("no duplicate inbound entries if A links to B twice in same content", async () => {
    await writeTheme(
      vault,
      "theme-a",
      "First mention of [[theme-b]] and second mention of [[theme-b]]."
    );
    await writeTheme(vault, "theme-b", "No outbound links.");
    const result = await buildBacklinks(vault);
    const inbound = result.get("theme-b") ?? [];
    expect(inbound.filter((t) => t === "theme-a")).toHaveLength(1);
  });

  it("multiple themes linking to the same target are all included", async () => {
    await writeTheme(vault, "theme-a", "Links to [[shared-target]].");
    await writeTheme(vault, "theme-b", "Also links to [[shared-target]].");
    await writeTheme(vault, "shared-target", "I am the target.");
    const result = await buildBacklinks(vault);
    const inbound = result.get("shared-target") ?? [];
    expect(inbound).toContain("theme-a");
    expect(inbound).toContain("theme-b");
  });

  it("inbound list is sorted alphabetically", async () => {
    await writeTheme(vault, "zebra", "Links to [[target]].");
    await writeTheme(vault, "apple", "Links to [[target]].");
    await writeTheme(vault, "mango", "Links to [[target]].");
    await writeTheme(vault, "target", "Target content.");
    const result = await buildBacklinks(vault);
    const inbound = result.get("target") ?? [];
    expect(inbound).toEqual([...inbound].sort());
    expect(inbound[0]).toBe("apple");
    expect(inbound[1]).toBe("mango");
    expect(inbound[2]).toBe("zebra");
  });

  it("all known themes are pre-populated as keys even with no links", async () => {
    await writeTheme(vault, "lone-wolf", "No links, standalone content.");
    await writeTheme(vault, "another-lone", "Also standalone.");
    const result = await buildBacklinks(vault);
    expect(result.has("lone-wolf")).toBe(true);
    expect(result.has("another-lone")).toBe(true);
    expect(result.get("lone-wolf")).toEqual([]);
    expect(result.get("another-lone")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeBacklinksFile
// ---------------------------------------------------------------------------
describe("writeBacklinksFile", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates _backlinks.md in vault.warmDir", async () => {
    const backlinks = new Map<string, string[]>([["theme-a", []]]);
    await writeBacklinksFile(vault, backlinks);
    const filePath = join(vault.warmDir, "_backlinks.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBeTruthy();
  });

  it("contains # Backlinks header", async () => {
    const backlinks = new Map<string, string[]>([["alpha", []]]);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("# Backlinks");
  });

  it("each theme has a ## [[theme-name]] section", async () => {
    const backlinks = new Map<string, string[]>([
      ["theme-x", []],
      ["theme-y", ["theme-x"]],
    ]);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("## [[theme-x]]");
    expect(content).toContain("## [[theme-y]]");
  });

  it("themes with no inbound links show _No inbound links._", async () => {
    const backlinks = new Map<string, string[]>([["lonely", []]]);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("_No inbound links._");
  });

  it("themes with inbound links show - [[linking-theme]] entries", async () => {
    const backlinks = new Map<string, string[]>([
      ["target", ["linker-a", "linker-b"]],
    ]);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("- [[linker-a]]");
    expect(content).toContain("- [[linker-b]]");
  });

  it("file is sorted alphabetically by theme name", async () => {
    const backlinks = new Map<string, string[]>([
      ["zebra", []],
      ["apple", []],
      ["mango", []],
    ]);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    const applePos = content.indexOf("## [[apple]]");
    const mangoPos = content.indexOf("## [[mango]]");
    const zebraPos = content.indexOf("## [[zebra]]");
    expect(applePos).toBeLessThan(mangoPos);
    expect(mangoPos).toBeLessThan(zebraPos);
  });

  it("integrates with buildBacklinks end-to-end", async () => {
    await writeTheme(vault, "source-theme", "Contains a link to [[dest-theme]].");
    await writeTheme(vault, "dest-theme", "Destination content.");
    const backlinks = await buildBacklinks(vault);
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("## [[dest-theme]]");
    expect(content).toContain("- [[source-theme]]");
  });

  it("writes empty backlinks file gracefully when no themes", async () => {
    const backlinks = new Map<string, string[]>();
    await writeBacklinksFile(vault, backlinks);
    const content = await readFile(join(vault.warmDir, "_backlinks.md"), "utf-8");
    expect(content).toContain("# Backlinks");
    // No theme sections
    expect(content).not.toContain("## [[");
  });
});
