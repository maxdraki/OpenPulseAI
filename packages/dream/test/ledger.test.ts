import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, parseActivityBlocks } from "@openpulse/core";
import {
  computeEntryId,
  loadProcessedLedger,
  saveProcessedLedger,
  filterUnprocessed,
  markProcessed,
  pruneLedgerForEntries,
} from "../src/ledger.js";

describe("ledger", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-ledger-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("computeEntryId is stable for identical content and differs for different content", () => {
    const a = { timestamp: "2026-04-01T00:00:00Z", log: "did stuff", source: "github-activity" };
    const b = { timestamp: "2026-04-01T00:00:00Z", log: "did stuff", source: "github-activity" };
    const c = { timestamp: "2026-04-01T00:00:00Z", log: "did other stuff", source: "github-activity" };

    expect(computeEntryId(a)).toBe(computeEntryId(b));
    expect(computeEntryId(a)).not.toBe(computeEntryId(c));
    expect(computeEntryId(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("loadProcessedLedger returns {} when no ledger file exists yet", async () => {
    const ledger = await loadProcessedLedger(vault);
    expect(ledger).toEqual({});
  });

  it("round-trips through saveProcessedLedger/loadProcessedLedger", async () => {
    const entry = { timestamp: "2026-04-01T00:00:00Z", log: "did stuff" };
    const ledger = markProcessed([entry], {}, "batch-1");
    await saveProcessedLedger(vault, ledger);

    const reloaded = await loadProcessedLedger(vault);
    expect(reloaded[computeEntryId(entry)].batchId).toBe("batch-1");
  });

  it("filterUnprocessed excludes entries already marked processed", () => {
    const processedEntry = { timestamp: "2026-04-01T00:00:00Z", log: "already done" };
    const newEntry = { timestamp: "2026-04-02T00:00:00Z", log: "new work" };
    const ledger = markProcessed([processedEntry], {}, "batch-1");

    const result = filterUnprocessed([processedEntry, newEntry], ledger);

    expect(result).toEqual([newEntry]);
  });

  it("pruneLedgerForEntries removes only the given entries' rows and returns the same reference when nothing changes", () => {
    const keep = { timestamp: "2026-04-01T00:00:00Z", log: "keep me" };
    const remove = { timestamp: "2026-04-02T00:00:00Z", log: "remove me" };
    const ledger = markProcessed([keep, remove], {}, "batch-1");

    const pruned = pruneLedgerForEntries([remove], ledger);
    expect(pruned[computeEntryId(remove)]).toBeUndefined();
    expect(pruned[computeEntryId(keep)]).toBeDefined();

    const unchanged = pruneLedgerForEntries([{ timestamp: "2026-01-01T00:00:00Z", log: "not present" }], pruned);
    expect(unchanged).toBe(pruned);
  });

  it("computeEntryId for legacy entries is stable before and after a marker entry is appended to the same hot file", () => {
    // This is the actual data-integrity property the splitHotFileBlocks fix protects:
    // if parsing corrupts/merges the legacy blocks once a marker entry is appended,
    // their content-derived ledger IDs would change and previously-processed
    // entries would look "new" again, causing reprocessing/duplicate pendings.
    const legacyPortion =
      `## 2026-04-18T10:00:00Z\n**Source:** a\n\nLegacy entry one.\n\n---\n\n` +
      `## 2026-04-18T11:00:00Z\n**Source:** b\n\nLegacy entry two.\n\n---\n`;

    const idsBefore = parseActivityBlocks(legacyPortion).map(computeEntryId);
    expect(idsBefore).toHaveLength(2);

    const markerPortion =
      `\n## 2026-04-18T12:00:00Z\n**Source:** c\n\nNew marker entry.\n\n${"<!-- openpulse:entry -->"}\n\n`;
    const mixedContent = legacyPortion + markerPortion;

    const blocksAfter = parseActivityBlocks(mixedContent);
    expect(blocksAfter).toHaveLength(3);
    const idsAfter = blocksAfter.slice(0, 2).map(computeEntryId);

    expect(idsAfter).toEqual(idsBefore);
  });
});
