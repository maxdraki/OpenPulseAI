import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
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
