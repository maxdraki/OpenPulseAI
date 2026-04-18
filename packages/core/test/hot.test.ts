import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import {
  appendActivity,
  saveIngestedDocument,
  parseActivityBlock,
  parseActivityBlocks,
} from "../src/hot.js";

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

    it("skips duplicate entry with same source and log within the 60s window", async () => {
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:00Z",
        log: "Collected 5 commits",
        source: "github-activity",
      });
      // Same content, 30s later — simulates missed-run catch-up then scheduled fire
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:30Z",
        log: "Collected 5 commits",
        source: "github-activity",
      });
      const content = await readFile(vault.dailyLogPath("2026-04-03"), "utf-8");
      const blocks = content.split("---").filter((b) => b.trim());
      expect(blocks).toHaveLength(1);
    });

    it("keeps entries with the same log but different source", async () => {
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:00Z",
        log: "No activity since last run.",
        source: "github-activity",
      });
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:15Z",
        log: "No activity since last run.",
        source: "folder-watcher",
      });
      const content = await readFile(vault.dailyLogPath("2026-04-03"), "utf-8");
      const blocks = content.split("---").filter((b) => b.trim());
      expect(blocks).toHaveLength(2);
    });

    it("keeps entries with same source/log outside the 60s dedup window", async () => {
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:00:00Z",
        log: "Collected 5 commits",
        source: "github-activity",
      });
      // 2 minutes later — legitimate second collection
      await appendActivity(vault, {
        timestamp: "2026-04-03T10:02:00Z",
        log: "Collected 5 commits",
        source: "github-activity",
      });
      const content = await readFile(vault.dailyLogPath("2026-04-03"), "utf-8");
      const blocks = content.split("---").filter((b) => b.trim());
      expect(blocks).toHaveLength(2);
    });
  });

  describe("parseActivityBlock / parseActivityBlocks", () => {
    it("extracts timestamp, theme, source, and log from a single block", () => {
      const block = `## 2026-04-18T10:00:00Z\n**Theme:** project-auth\n**Source:** github-activity\n\nRefactored login.\n\nAdded tests.`;
      const parsed = parseActivityBlock(block);
      expect(parsed).toEqual({
        timestamp: "2026-04-18T10:00:00Z",
        theme: "project-auth",
        source: "github-activity",
        log: "Refactored login.\nAdded tests.",
      });
    });

    it("returns null for a block with no timestamp header", () => {
      expect(parseActivityBlock("just some text\nno header")).toBeNull();
    });

    it("returns null for a block with header but no log body", () => {
      expect(parseActivityBlock("## 2026-04-18T10:00:00Z\n**Theme:** x\n")).toBeNull();
    });

    it("splits a multi-block file and drops empty trailing blocks", () => {
      const content = `## 2026-04-18T10:00:00Z\n**Source:** a\n\nEntry one.\n\n---\n\n## 2026-04-18T11:00:00Z\n**Source:** b\n\nEntry two.\n\n---\n`;
      const blocks = parseActivityBlocks(content);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].source).toBe("a");
      expect(blocks[1].source).toBe("b");
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
