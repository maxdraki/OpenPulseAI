import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import { appendActivity, saveIngestedDocument } from "../src/hot.js";

describe("Hot Layer", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-hot-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe("appendActivity", () => {
    it("creates a new daily log and appends an entry", async () => {
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:00Z",
        log: "Refactored login page",
        theme: "project-auth",
      });

      const content = await readFile(
        vault.dailyLogPath("2026-04-03"),
        "utf-8"
      );
      expect(content).toContain("Refactored login page");
      expect(content).toContain("project-auth");
      expect(content).toContain("2026-04-03T10:00:00Z");
    });

    it("appends to existing daily log", async () => {
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:00Z",
        log: "First entry",
      });
      await appendActivity(vault, {
        timestamp: "2026-04-03T11:00:00Z",
        log: "Second entry",
      });

      const content = await readFile(
        vault.dailyLogPath("2026-04-03"),
        "utf-8"
      );
      expect(content).toContain("First entry");
      expect(content).toContain("Second entry");
    });
  });

  describe("saveIngestedDocument", () => {
    it("saves a document to the ingest folder", async () => {
      await saveIngestedDocument(vault, "requirements.md", "# Requirements\n\n- Feature A");

      const content = await readFile(
        join(vault.ingestDir, "requirements.md"),
        "utf-8"
      );
      expect(content).toBe("# Requirements\n\n- Feature A");
    });
  });
});
