import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { handleIngestDocument } from "../src/tools/ingest-document.js";

describe("ingest_document tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("saves document and returns confirmation", async () => {
    const result = await handleIngestDocument(vault, {
      filename: "notes.md",
      content: "# My Notes\n\nSome content here.",
    });
    expect(result.content[0].text).toBe("Ingested document: notes.md");
    const saved = await readFile(join(vault.ingestDir, "notes.md"), "utf-8");
    expect(saved).toContain("Some content here.");
  });

  it("returns confirmation with the filename", async () => {
    const result = await handleIngestDocument(vault, {
      filename: "architecture.md",
      content: "# Architecture",
    });
    expect(result.content[0].text).toContain("architecture.md");
  });
});
