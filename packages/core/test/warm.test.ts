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

  it("round-trips skills, status, and statusReason through frontmatter", async () => {
    await writeTheme(vault, "openpulse", "Body content here.", {
      type: "project",
      skills: ["typescript", "system-design"],
      status: "blocked",
      statusReason: 'waiting for review on PR #42: "auth migration"',
    });

    const doc = await readTheme(vault, "openpulse");
    expect(doc).not.toBeNull();
    expect(doc!.skills).toEqual(["typescript", "system-design"]);
    expect(doc!.status).toBe("blocked");
    expect(doc!.statusReason).toBe('waiting for review on PR #42: "auth migration"');
    expect(doc!.type).toBe("project");
  });

  it("ignores invalid status values in frontmatter", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      vault.themeFilePath("rogue"),
      `---
theme: rogue
lastUpdated: 2026-04-18T10:00:00Z
type: project
status: bogus-status
---

Body.
`,
      "utf-8"
    );
    const doc = await readTheme(vault, "rogue");
    expect(doc).not.toBeNull();
    expect(doc!.status).toBeUndefined();
  });

  it("omits skills/status fields from frontmatter when not provided", async () => {
    await writeTheme(vault, "plain", "No metadata.", { type: "project" });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(vault.themeFilePath("plain"), "utf-8");
    expect(raw).not.toContain("skills:");
    expect(raw).not.toContain("status:");
    expect(raw).not.toContain("statusReason:");
  });

  it("round-trips statusReason values containing colons, quotes, and newlines", async () => {
    const tricky = `waiting on PR #42: "auth migration" — see discussion: https://example.com/thread`;
    await writeTheme(vault, "tricky", "Body.", {
      type: "project",
      status: "blocked",
      statusReason: tricky,
    });
    const doc = await readTheme(vault, "tricky");
    expect(doc!.statusReason).toBe(tricky);
  });

  it("caps skills at MAX_SKILLS_ON_THEME when writing", async () => {
    const manySkills = Array.from({ length: 40 }, (_, i) => `skill-${i}`);
    await writeTheme(vault, "crowded", "Body.", { type: "project", skills: manySkills });
    const doc = await readTheme(vault, "crowded");
    expect(doc!.skills!.length).toBeLessThanOrEqual(20);
    expect(doc!.skills![0]).toBe("skill-0");
  });
});
