import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, appendActivity, getLocalDate } from "@openpulse/core";
import type { LlmProvider, OpenPulseConfig } from "@openpulse/core";
import { runDreamPipeline } from "../src/index.js";
import { loadProcessedLedger, saveProcessedLedger, markProcessed } from "../src/ledger.js";

function mockProvider(response = "## Current Status\n\nDid stuff ^[src:test]"): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function makeConfig(vaultPath: string, themes: string[] = ["myproject"]): OpenPulseConfig {
  return {
    vaultPath,
    themes,
    llm: { provider: "anthropic", model: "test-model" },
  };
}

async function pendingFiles(vault: Vault): Promise<string[]> {
  try {
    return await readdir(vault.pendingDir);
  } catch {
    return [];
  }
}

describe("runDreamPipeline", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-dream-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns null and does nothing when there are no hot entries", async () => {
    const result = await runDreamPipeline(vault, makeConfig(tempDir), mockProvider(), "test-model");
    expect(result).toBeNull();
  });

  it("processes today's entries, marks them in the ledger, and never archives today's file", async () => {
    const today = getLocalDate();
    await appendActivity(vault, { timestamp: `${today}T09:00:00Z`, log: "Committed changes to myproject", theme: "myproject" });

    const provider = mockProvider();
    const result = await runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model");

    expect(result?.pending).toHaveLength(1);
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // Today's hot file must still exist, unarchived.
    const stillThere = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(stillThere).toContain("Committed changes to myproject");
    const todayMonth = today.slice(0, 7);
    await expect(readFile(join(vault.coldDir, todayMonth, `${today}.md`), "utf-8")).rejects.toThrow();
  });

  it("survives an entry appended to today's file after a run, and picks it up on the next run without reprocessing the first", async () => {
    const today = getLocalDate();
    await appendActivity(vault, { timestamp: `${today}T09:00:00Z`, log: "Committed first entry to myproject", theme: "myproject" });

    const provider = mockProvider();
    const first = await runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model");
    expect(first?.pending).toHaveLength(1);
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // Simulate a collector appending to today's file mid/after the run —
    // the entry must not be lost, and the first entry must not be reprocessed.
    await appendActivity(vault, { timestamp: `${today}T10:00:00Z`, log: "Committed second entry to myproject", theme: "myproject" });

    const second = await runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model");
    expect(second?.pending).toHaveLength(1);
    // Only the new entry should have been classified/synthesized this run.
    expect(second?.pending[0].entries).toHaveLength(1);
    expect(second?.pending[0].entries[0].log).toBe("Committed second entry to myproject");

    // Today's file (both entries) is still present — never archived.
    const content = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(content).toContain("Committed first entry to myproject");
    expect(content).toContain("Committed second entry to myproject");

    // Total pending updates across both runs: 2, not deduplicated into 1 and not tripled.
    expect(await pendingFiles(vault)).toHaveLength(2);
  });

  it("archives a fully-processed old hot file even when there are zero new entries to classify", async () => {
    // Regression for the early-return bug: when `entries.length === 0` the
    // pipeline used to return before ever calling `archiveProcessedHotFiles`,
    // so an old (non-today) hot file whose entries were already marked
    // processed by a previous run — but never got archived, e.g. because
    // that run crashed between the ledger write and archiving — would sit in
    // hot/ forever on every subsequent quiet day (no new entries appended).
    const oldDate = "2026-04-01";
    const oldEntry = { timestamp: `${oldDate}T09:00:00Z`, log: "Old already-processed entry", theme: "myproject" };
    await appendActivity(vault, oldEntry);

    const ledger = await loadProcessedLedger(vault);
    await saveProcessedLedger(vault, markProcessed([oldEntry], ledger, "batch-prior"));

    const provider = mockProvider();
    const result = await runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model");

    expect(result).toBeNull();
    expect(provider.complete).not.toHaveBeenCalled();

    // The old hot file must have been archived despite there being no new
    // entries to process this run.
    await expect(stat(vault.dailyLogPath(oldDate))).rejects.toThrow();
    const archived = await readFile(join(vault.coldDir, oldDate.slice(0, 7), `${oldDate}.md`), "utf-8");
    expect(archived).toContain("Old already-processed entry");
  });

  it("keeps hot files and the ledger untouched when synthesis fails", async () => {
    const today = getLocalDate();
    await appendActivity(vault, { timestamp: `${today}T09:00:00Z`, log: "Committed work that will fail to myproject", theme: "myproject" });

    const provider: LlmProvider = { complete: vi.fn().mockRejectedValue(new Error("LLM down")) };

    await expect(runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model")).rejects.toThrow("LLM down");

    const content = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(content).toContain("Committed work that will fail to myproject");
    expect(await pendingFiles(vault)).toHaveLength(0);

    // Re-running with a working provider should still classify/synthesize the entry —
    // it must NOT have been marked processed by the failed run.
    const workingProvider = mockProvider();
    const retry = await runDreamPipeline(vault, makeConfig(tempDir), workingProvider, "test-model");
    expect(retry?.pending).toHaveLength(1);
  });
});
