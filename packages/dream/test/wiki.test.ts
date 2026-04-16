import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import { generateIndex, appendLog } from "../src/index.js";

describe("generateIndex", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-wiki-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("generates index.md with [[wiki-link]] format for each theme", async () => {
    // Create two mock theme files with frontmatter
    const theme1 = `---\nlastUpdated: 2026-04-03T12:00:00Z\n---\n## Current Status\n\nAuth is done.\n`;
    const theme2 = `---\nlastUpdated: 2026-04-02T08:00:00Z\n---\n## Current Status\n\nHiring pipeline active.\n`;

    await writeFile(join(vault.warmDir, "project-auth.md"), theme1, "utf-8");
    await writeFile(join(vault.warmDir, "hiring.md"), theme2, "utf-8");

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("[[project-auth]]");
    expect(index).toContain("[[hiring]]");
  });

  it("excludes index.md, log.md, and _pending from the index", async () => {
    // Create a regular theme
    const themeContent = `---\nlastUpdated: 2026-04-03T10:00:00Z\n---\n## Current Status\n\nActive.\n`;
    await writeFile(join(vault.warmDir, "my-project.md"), themeContent, "utf-8");

    // Create files that should be excluded
    await writeFile(join(vault.warmDir, "index.md"), "old index content", "utf-8");
    await writeFile(join(vault.warmDir, "log.md"), "## log entry", "utf-8");

    // _pending dir already exists via vault.init()

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("[[my-project]]");
    expect(index).not.toContain("[[index]]");
    expect(index).not.toContain("[[log]]");
    expect(index).not.toContain("[[_pending]]");
  });

  it("produces valid index.md with theme count summary", async () => {
    const theme1 = `---\nlastUpdated: 2026-04-03T10:00:00Z\n---\n## Current Status\n\nDone.\n`;
    const theme2 = `---\nlastUpdated: 2026-04-03T11:00:00Z\n---\n## Current Status\n\nIn progress.\n`;

    await writeFile(join(vault.warmDir, "alpha.md"), theme1, "utf-8");
    await writeFile(join(vault.warmDir, "beta.md"), theme2, "utf-8");

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("2 themes");
    expect(index).toContain("# OpenPulse Knowledge Base");
  });
});

describe("generateIndex — grouped by type", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-wiki-grouped-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("places project-type themes under ## Projects section", async () => {
    await writeTheme(vault, "my-project", "## Current Status\n\nActive work here.", { type: "project" });

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("## Projects");
    expect(index).toContain("[[my-project]]");
    // The item should appear after the ## Projects heading
    const projectsPos = index.indexOf("## Projects");
    const itemPos = index.indexOf("[[my-project]]");
    expect(itemPos).toBeGreaterThan(projectsPos);
  });

  it("places concept-type themes under ## Concepts section", async () => {
    await writeTheme(vault, "ci-cd", "## Definition\n\nContinuous integration and delivery.", { type: "concept" });

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("## Concepts");
    expect(index).toContain("[[ci-cd]]");
    const conceptsPos = index.indexOf("## Concepts");
    const itemPos = index.indexOf("[[ci-cd]]");
    expect(itemPos).toBeGreaterThan(conceptsPos);
  });

  it("formats items as - [[name]] — summary (date)", async () => {
    await writeTheme(vault, "feature-x", "## Current Status\n\nIn progress now.", { type: "project" });

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    // Should have summary extracted from ## Current Status
    expect(index).toMatch(/- \[\[feature-x\]\] — In progress now\. \(\d+ \w+\)/);
  });

  it("groups themes with different types into separate sections", async () => {
    await writeTheme(vault, "auth-service", "## Current Status\n\nDone.", { type: "project" });
    await writeTheme(vault, "oauth", "## Definition\n\nOpen auth protocol.", { type: "concept" });
    await writeTheme(vault, "alice", "## Summary\n\nLead engineer.", { type: "entity" });

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("## Projects");
    expect(index).toContain("## Concepts");
    expect(index).toContain("## Entities");
    expect(index).toContain("[[auth-service]]");
    expect(index).toContain("[[oauth]]");
    expect(index).toContain("[[alice]]");
    expect(index).toContain("3 themes");
  });

  it("themes without a type field default to project", async () => {
    // Write without type in frontmatter
    const rawContent = `---\nlastUpdated: 2026-04-10T10:00:00Z\n---\n## Current Status\n\nNo type specified.\n`;
    await writeFile(join(vault.warmDir, "no-type.md"), rawContent, "utf-8");

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    expect(index).toContain("## Projects");
    expect(index).toContain("[[no-type]]");
  });

  it("does not render empty type sections", async () => {
    await writeTheme(vault, "thing-a", "## Current Status\n\nActive.", { type: "project" });

    await generateIndex(vault);

    const index = await readFile(join(vault.warmDir, "index.md"), "utf-8");
    // Only project exists — Concepts, Entities, Sources should not appear
    expect(index).not.toContain("## Concepts");
    expect(index).not.toContain("## Entities");
    expect(index).not.toContain("## Sources");
  });
});

describe("appendLog", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-log-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("appends log entries without overwriting previous entries", async () => {
    await appendLog(vault, "dream", "5 entries → 2 updates (auth, hiring)");
    await appendLog(vault, "dream", "3 entries → 1 update (docs)");

    const log = await readFile(join(vault.warmDir, "log.md"), "utf-8");

    expect(log).toContain("5 entries → 2 updates (auth, hiring)");
    expect(log).toContain("3 entries → 1 update (docs)");
  });

  it("uses the format ## [date] type | detail", async () => {
    await appendLog(vault, "dream", "test detail");

    const log = await readFile(join(vault.warmDir, "log.md"), "utf-8");

    // Match format: ## [YYYY-MM-DD HH:MM] dream | test detail
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] dream \| test detail$/m);
  });

  it("second call appends rather than overwrites first entry", async () => {
    await appendLog(vault, "dream", "first entry");
    await appendLog(vault, "skill", "second entry");

    const log = await readFile(join(vault.warmDir, "log.md"), "utf-8");
    const lines = log.split("\n").filter((l) => l.startsWith("## ["));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first entry");
    expect(lines[1]).toContain("second entry");
  });
});
