import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import {
  DEFAULT_TEMPLATES,
  DEFAULT_SCHEMA_CONTENT,
  loadSchema,
  seedSchema,
  parseSchema,
} from "../src/schema.js";

describe("DEFAULT_TEMPLATES", () => {
  it("has all four ThemeType keys", () => {
    expect(Object.keys(DEFAULT_TEMPLATES)).toEqual(
      expect.arrayContaining(["project", "concept", "entity", "source-summary"])
    );
  });

  it("each template has structure and rules", () => {
    for (const tmpl of Object.values(DEFAULT_TEMPLATES)) {
      expect(tmpl.structure).toBeTruthy();
      expect(tmpl.rules).toBeTruthy();
    }
  });
});

describe("parseSchema", () => {
  it("returns default templates when schema is empty", () => {
    const result = parseSchema("");
    expect(result).toEqual(DEFAULT_TEMPLATES);
  });

  it("overrides structure for a type when present in schema", () => {
    const raw = `# Wiki Schema\n\n### project\nStructure: ## Overview\nRules: Keep it short.\n`;
    const result = parseSchema(raw);
    expect(result.project.structure).toBe("## Overview");
    expect(result.project.rules).toBe("Keep it short.");
  });

  it("falls back to default for types not in schema", () => {
    const raw = `# Wiki Schema\n\n### project\nStructure: ## Custom\nRules: Custom rules.\n`;
    const result = parseSchema(raw);
    // concept not in schema → uses default
    expect(result.concept).toEqual(DEFAULT_TEMPLATES.concept);
  });
});

describe("loadSchema + seedSchema", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-schema-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("loadSchema returns defaults when _schema.md is absent", async () => {
    const result = await loadSchema(vault);
    expect(result).toEqual(DEFAULT_TEMPLATES);
  });

  it("loadSchema reads _schema.md when present", async () => {
    const custom = `# Wiki Schema\n\n### project\nStructure: ## Custom Status\nRules: Custom rules.\n`;
    await writeFile(join(vault.warmDir, "_schema.md"), custom, "utf-8");
    const result = await loadSchema(vault);
    expect(result.project.structure).toBe("## Custom Status");
  });

  it("seedSchema creates _schema.md when absent", async () => {
    await seedSchema(vault);
    const content = await readFile(join(vault.warmDir, "_schema.md"), "utf-8");
    expect(content).toContain("# Wiki Schema");
    expect(content).toContain("### project");
    expect(content).toContain("### concept");
  });

  it("seedSchema is idempotent — does not overwrite existing file", async () => {
    const original = "# Custom\n\nMy schema.";
    await writeFile(join(vault.warmDir, "_schema.md"), original, "utf-8");
    await seedSchema(vault); // should NOT overwrite
    const after = await readFile(join(vault.warmDir, "_schema.md"), "utf-8");
    expect(after).toBe(original);
  });

  it("load after seed round-trips to DEFAULT_TEMPLATES", async () => {
    await seedSchema(vault);
    const result = await loadSchema(vault);
    expect(result).toEqual(DEFAULT_TEMPLATES);
  });
});
