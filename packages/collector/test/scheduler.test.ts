import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { isDue, loadCollectorState, saveCollectorState } from "../src/scheduler.js";

describe("Scheduler", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-sched-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("isDue returns true when source has never run", () => {
    expect(isDue("0 23 * * *", null, new Date())).toBe(true);
  });

  it("saves and loads collector state", async () => {
    const state = { sourceName: "gmail", lastRunAt: new Date().toISOString(), lastStatus: "success" as const, entriesCollected: 5 };
    await saveCollectorState(vault, state);
    const loaded = await loadCollectorState(vault, "gmail");
    expect(loaded).not.toBeNull();
    expect(loaded!.entriesCollected).toBe(5);
  });

  it("returns null for unknown source state", async () => {
    const loaded = await loadCollectorState(vault, "nonexistent");
    expect(loaded).toBeNull();
  });
});
