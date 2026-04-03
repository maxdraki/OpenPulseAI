import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import {
  readTheme,
  writeTheme,
  listThemes,
  readAllThemes,
} from "../src/warm.js";

describe("Warm Layer", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-warm-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writeTheme creates a theme file with frontmatter", async () => {
    await writeTheme(vault, "project-auth", "Login page refactored.");

    const doc = await readTheme(vault, "project-auth");
    expect(doc).not.toBeNull();
    expect(doc!.theme).toBe("project-auth");
    expect(doc!.content).toContain("Login page refactored.");
    expect(doc!.lastUpdated).toBeTruthy();
  });

  it("readTheme returns null for nonexistent theme", async () => {
    const doc = await readTheme(vault, "nonexistent");
    expect(doc).toBeNull();
  });

  it("listThemes returns all theme names, excluding _pending dir", async () => {
    await writeTheme(vault, "project-auth", "Auth stuff");
    await writeTheme(vault, "hiring", "Hiring stuff");

    const themes = await listThemes(vault);
    expect(themes.sort()).toEqual(["hiring", "project-auth"]);
  });

  it("readAllThemes returns all theme documents", async () => {
    await writeTheme(vault, "project-auth", "Auth stuff");
    await writeTheme(vault, "hiring", "Hiring stuff");

    const docs = await readAllThemes(vault);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.theme).sort()).toEqual(["hiring", "project-auth"]);
  });
});
