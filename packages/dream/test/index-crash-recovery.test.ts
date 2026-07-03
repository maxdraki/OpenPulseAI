import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, appendActivity } from "@openpulse/core";
import type { LlmProvider, OpenPulseConfig } from "@openpulse/core";

// Isolate this module's mock of archive.js to this file only — other dream
// pipeline tests need the real archiveProcessedHotFiles behavior.
vi.mock("../src/archive.js", () => ({
  archiveProcessedHotFiles: vi.fn(),
}));

import { archiveProcessedHotFiles } from "../src/archive.js";
import { runDreamPipeline } from "../src/index.js";

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

describe("runDreamPipeline — crash between ledger write and archive", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-dream-crash-"));
    vault = new Vault(tempDir);
    await vault.init();
    vi.mocked(archiveProcessedHotFiles).mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("does not create a duplicate pending update on re-run after a crash during archiving", async () => {
    // Non-today date — eligible for archiving once the run reaches that step.
    const yesterday = "2026-04-01";
    await appendActivity(vault, {
      timestamp: `${yesterday}T09:00:00Z`,
      log: "Committed old entry to myproject",
      theme: "myproject",
    });

    const provider = mockProvider();

    // First run: pending + ledger are written, then archive() throws —
    // simulating a process crash right after the crash-window-closing ledger
    // write but before the hot file is actually moved to cold storage.
    vi.mocked(archiveProcessedHotFiles).mockRejectedValueOnce(new Error("simulated crash during archive"));
    await expect(
      runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model")
    ).rejects.toThrow("simulated crash during archive");

    expect(await pendingFiles(vault)).toHaveLength(1);
    // Hot file is still present — archive() never completed.
    const stillThere = await readFile(vault.dailyLogPath(yesterday), "utf-8");
    expect(stillThere).toContain("Committed old entry to myproject");

    // Second run: archive succeeds this time, but the entry was already
    // marked processed by the first run's ledger write — it must not be
    // reclassified/resynthesized into a duplicate pending update.
    vi.mocked(archiveProcessedHotFiles).mockResolvedValueOnce(undefined);
    const second = await runDreamPipeline(vault, makeConfig(tempDir), provider, "test-model");

    expect(second).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(1); // no second synthesis call
    expect(await pendingFiles(vault)).toHaveLength(1); // no duplicate pending update
  });
});
