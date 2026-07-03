import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, stat, readFile, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, getLocalDate, appendActivity } from "@openpulse/core";
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

  it("never archives the UTC-dated hot file mid-append in the local-midnight-to-UTC-midnight window (positive UTC offset)", async () => {
    // Reproduces the reviewer's repro: freeze the clock at 2026-07-03T00:30
    // local time in a fixed UTC+1 zone (Etc/GMT-1, no DST) = 2026-07-02T23:30Z.
    // `getLocalDate()` says "today" is 2026-07-03, but `appendActivity` names
    // hot files from `entry.timestamp.slice(0, 10)` where the timestamp comes
    // from `new Date().toISOString()` (UTC) — so a collector appending "now"
    // writes into hot/2026-07-02.md, not hot/2026-07-03.md. A local-only
    // cutoff would archive 2026-07-02.md as "not today", losing the append.
    const originalTZ = process.env.TZ;
    process.env.TZ = "Etc/GMT-1"; // fixed UTC+1, no DST — deterministic across CI machines
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T23:30:00.000Z"));

    try {
      // Sanity-check the premise: local "today" and UTC "today" really do differ.
      expect(getLocalDate()).toBe("2026-07-03");
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-02");

      // Simulate a collector appending an entry mid-Dream-run, exactly as
      // `runner.ts` does: `timestamp: now.toISOString()`.
      await appendActivity(vault, {
        timestamp: new Date().toISOString(),
        log: "Live append during the local/UTC rollover window",
        source: "github-activity",
      });

      // The append must have landed in the UTC-dated file.
      const utcFileContent = await readFile(vault.dailyLogPath("2026-07-02"), "utf-8");
      expect(utcFileContent).toContain("Live append during the local/UTC rollover window");

      await archiveProcessedHotFiles(vault);

      // Must survive archiving — under the old local-only cutoff this file
      // would have been archived (it doesn't match local "today" 2026-07-03).
      const stillThere = await readFile(vault.dailyLogPath("2026-07-02"), "utf-8");
      expect(stillThere).toContain("Live append during the local/UTC rollover window");
      await expect(
        readFile(join(vault.coldDir, "2026-07", "2026-07-02.md"), "utf-8")
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
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

  // C1 (blocking): a theme's synthesis can fail/be refused, leaving some of
  // its entries deliberately NOT marked processed in the ledger so they're
  // retried next run. Previously `archiveProcessedHotFiles` ignored the
  // ledger entirely and archived every non-today daily file (and every
  // ingest file) regardless — silently losing those deferred entries forever
  // once their file hit cold storage.

  it("does NOT archive a non-today daily file that contains a deferred (unprocessed) entry", async () => {
    const oldBlock =
      "## 2026-04-02T09:00:00Z\n**Source:** github-activity\n\nDeferred entry, theme synth failed\n\n---\n";
    await writeFile(vault.dailyLogPath("2026-04-02"), oldBlock, "utf-8");
    const today = getLocalDate();
    await writeFile(vault.dailyLogPath(today), "# Today log", "utf-8");

    // Ledger has nothing for this entry — it was deferred, never marked processed.
    await saveProcessedLedger(vault, {});

    await archiveProcessedHotFiles(vault);

    // File must survive so the entry is retried on the next dream run.
    const stillThere = await readFile(vault.dailyLogPath("2026-04-02"), "utf-8");
    expect(stillThere).toBe(oldBlock);
    await expect(
      readFile(join(vault.coldDir, "2026-04", "2026-04-02.md"), "utf-8")
    ).rejects.toThrow();
  });

  it("archives a non-today daily file once ALL of its entries are marked processed", async () => {
    const oldBlock =
      "## 2026-04-02T09:00:00Z\n**Source:** github-activity\n\nFully processed entry\n\n---\n";
    await writeFile(vault.dailyLogPath("2026-04-02"), oldBlock, "utf-8");
    const today = getLocalDate();
    await writeFile(vault.dailyLogPath(today), "# Today log", "utf-8");

    const entry = { timestamp: "2026-04-02T09:00:00Z", log: "Fully processed entry", source: "github-activity" };
    await saveProcessedLedger(vault, {
      [computeEntryId(entry)]: { processedAt: "2026-04-02T10:00:00Z", batchId: "batch-1" },
    });

    await archiveProcessedHotFiles(vault);

    await expect(stat(vault.dailyLogPath("2026-04-02"))).rejects.toThrow();
    const archived = await readFile(join(vault.coldDir, "2026-04", "2026-04-02.md"), "utf-8");
    expect(archived).toBe(oldBlock);

    // Ledger row for the now-archived file's entry must be pruned.
    const afterLedger = await loadProcessedLedger(vault);
    expect(afterLedger[computeEntryId(entry)]).toBeUndefined();
  });

  it("does NOT archive a deferred (unprocessed) ingest file", async () => {
    const ingestDir = join(vault.hotDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const filePath = join(ingestDir, "doc1.md");
    await writeFile(filePath, "Ingested content", "utf-8");
    const mtime = new Date("2026-04-01T00:00:00Z");
    await utimes(filePath, mtime, mtime);

    // Ledger empty — this ingest entry was never marked processed.
    await saveProcessedLedger(vault, {});

    await archiveProcessedHotFiles(vault);

    // File must survive in hot/ingest for retry.
    const stillThere = await readFile(filePath, "utf-8");
    expect(stillThere).toBe("Ingested content");
  });

  it("archives a processed ingest file and prunes its ledger row (M1)", async () => {
    const ingestDir = join(vault.hotDir, "ingest");
    await mkdir(ingestDir, { recursive: true });
    const filePath = join(ingestDir, "doc1.md");
    await writeFile(filePath, "Ingested content", "utf-8");
    const mtime = new Date("2026-04-01T00:00:00Z");
    await utimes(filePath, mtime, mtime);

    const entry = {
      timestamp: mtime.toISOString(),
      log: "Ingested content",
      theme: "ingested",
      source: "doc1",
    };
    await saveProcessedLedger(vault, {
      [computeEntryId(entry)]: { processedAt: "2026-04-01T01:00:00Z", batchId: "batch-1" },
    });

    await archiveProcessedHotFiles(vault);

    await expect(stat(filePath)).rejects.toThrow();
    // Ingest files are archived under the CURRENT month (the archive run's
    // date), not the document's own mtime month — matches archive.ts's
    // existing `coldIngestDir` derivation.
    const month = new Date().toISOString().slice(0, 7);
    const archived = await readFile(join(vault.coldDir, month, "ingest", "doc1.md"), "utf-8");
    expect(archived).toBe("Ingested content");

    const afterLedger = await loadProcessedLedger(vault);
    expect(afterLedger[computeEntryId(entry)]).toBeUndefined();
  });
});
