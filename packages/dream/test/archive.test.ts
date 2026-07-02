import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, getLocalDate } from "@openpulse/core";
import { archiveProcessedHotFiles } from "../src/archive.js";
import { loadProcessedLedger, saveProcessedLedger, computeEntryId } from "../src/ledger.js";

describe("archiveProcessedHotFiles", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-archive-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("archives files strictly older than today but never archives today's file", async () => {
    await writeFile(vault.dailyLogPath("2026-04-02"), "# Old log", "utf-8");
    const today = getLocalDate();
    await writeFile(vault.dailyLogPath(today), "# Today log", "utf-8");

    await archiveProcessedHotFiles(vault);

    // Old file archived
    await expect(stat(vault.dailyLogPath("2026-04-02"))).rejects.toThrow();
    const archived = await readFile(join(vault.coldDir, "2026-04", "2026-04-02.md"), "utf-8");
    expect(archived).toBe("# Old log");

    // Today's file must survive — it may still be receiving appends mid-run
    const todayContent = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(todayContent).toBe("# Today log");
    const todayMonth = today.slice(0, 7);
    await expect(readFile(join(vault.coldDir, todayMonth, `${today}.md`), "utf-8")).rejects.toThrow();
  });

  it("prunes archived file's entries from the processed ledger, keeping unrelated entries", async () => {
    const oldBlock = "## 2026-04-02T09:00:00Z\n**Source:** github-activity\n\nDid old work\n\n---\n";
    await writeFile(vault.dailyLogPath("2026-04-02"), oldBlock, "utf-8");
    const today = getLocalDate();
    await writeFile(vault.dailyLogPath(today), "# Today log", "utf-8");

    const oldEntry = { timestamp: "2026-04-02T09:00:00Z", log: "Did old work", source: "github-activity" };
    const unrelatedEntry = { timestamp: "2026-01-01T00:00:00Z", log: "Unrelated", source: "manual" };

    const ledger = {
      [computeEntryId(oldEntry)]: { processedAt: "2026-04-02T10:00:00Z", batchId: "batch-1" },
      [computeEntryId(unrelatedEntry)]: { processedAt: "2026-04-02T10:00:00Z", batchId: "batch-1" },
    };
    await saveProcessedLedger(vault, ledger);

    await archiveProcessedHotFiles(vault);

    const afterLedger = await loadProcessedLedger(vault);
    expect(afterLedger[computeEntryId(oldEntry)]).toBeUndefined();
    expect(afterLedger[computeEntryId(unrelatedEntry)]).toBeDefined();
  });
});
