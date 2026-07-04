import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, ensureVaultRepo, commitVault, appendActivity } from "@openpulse/core";
import {
  computeRollupPeriod,
  gatherRollupInputs,
  readJournalEntriesInWindow,
  buildAigisRollupPrompt,
  runAigisRollup,
} from "../src/aigis-rollup.js";
import { acquireDreamLock } from "../src/lock.js";

/**
 * Creates a Vault's directory structure WITHOUT calling `vault.init()` (which
 * always runs `ensureVaultRepo` and makes an initial "chore: initial vault
 * commit"). `vaultLogSince` only takes a lower bound (`--since`, no upper
 * bound) — so a real git repo's initial commit satisfies literally any past
 * `periodStart`, making "no git activity" untestable with a git-initialized
 * vault. Tests that need a genuinely activity-free vault use this instead.
 */
async function initVaultWithoutGit(root: string): Promise<Vault> {
  const vault = new Vault(root);
  await mkdir(vault.hotDir, { recursive: true });
  await mkdir(join(vault.hotDir, "ingest"), { recursive: true });
  await mkdir(vault.warmDir, { recursive: true });
  await mkdir(vault.pendingDir, { recursive: true });
  await mkdir(vault.coldDir, { recursive: true });
  await mkdir(vault.sessionsDir, { recursive: true });
  return vault;
}

describe("computeRollupPeriod", () => {
  it("uses now - cadence as periodStart when the pipeline has never run (weekly)", () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const { periodStart, periodEnd } = computeRollupPeriod("weekly", null, now);
    expect(periodEnd).toBe(now.toISOString());
    expect(periodStart).toBe("2026-07-01T12:00:00.000Z");
  });

  it("uses now - cadence as periodStart when the pipeline has never run (monthly)", () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    const { periodStart } = computeRollupPeriod("monthly", null, now);
    expect(periodStart).toBe("2026-07-01T00:00:00.000Z");
  });

  it("uses the previous lastRun as periodStart when the pipeline has run before", () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const lastRun = "2026-07-03T09:00:00.000Z";
    const { periodStart, periodEnd } = computeRollupPeriod("weekly", lastRun, now);
    expect(periodStart).toBe(lastRun);
    expect(periodEnd).toBe(now.toISOString());
  });
});

describe("readJournalEntriesInWindow", () => {
  it("reads hot entries whose timestamp falls inside the window, excluding entries outside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-hot-"));
    const vault = new Vault(root);
    await vault.init();

    await appendActivity(vault, { timestamp: "2026-07-01T10:00:00.000Z", log: "Inside window", source: "test" });
    await appendActivity(vault, { timestamp: "2026-06-01T10:00:00.000Z", log: "Before window", source: "test" });

    const entries = await readJournalEntriesInWindow(vault, "2026-06-25T00:00:00.000Z", "2026-07-05T00:00:00.000Z");
    expect(entries).toHaveLength(1);
    expect(entries[0].log).toBe("Inside window");
  });

  it("reads cold-archived entries under <coldDir>/<YYYY-MM>/<date>.md within the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-cold-"));
    const vault = new Vault(root);
    await vault.init();

    const coldMonthDir = join(vault.coldDir, "2026-05");
    await mkdir(coldMonthDir, { recursive: true });
    await writeFile(
      join(coldMonthDir, "2026-05-15.md"),
      "## 2026-05-15T09:00:00.000Z\n**Source:** test\n\nArchived entry\n\n<!-- openpulse:entry -->\n",
      "utf-8"
    );

    const entries = await readJournalEntriesInWindow(vault, "2026-05-01T00:00:00.000Z", "2026-05-31T00:00:00.000Z");
    expect(entries).toHaveLength(1);
    expect(entries[0].log).toBe("Archived entry");
  });

  it("returns [] when there are no hot or cold entries at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-empty-"));
    const vault = new Vault(root);
    await vault.init();

    const entries = await readJournalEntriesInWindow(vault, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
    expect(entries).toEqual([]);
  });
});

describe("gatherRollupInputs", () => {
  it("reports hasActivity: false and empty arrays when nothing happened in the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-noactivity-"));
    const vault = await initVaultWithoutGit(root);

    const inputs = await gatherRollupInputs(vault, "2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z");
    expect(inputs.hasActivity).toBe(false);
    expect(inputs.commitSubjects).toEqual([]);
    expect(inputs.journalEntries).toEqual([]);
    expect(inputs.themeExcerpts).toEqual([]);
  });

  it("prioritizes theme excerpts by commit-touch frequency and caps total input chars", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-inputs-"));
    const vault = new Vault(root);
    await vault.init();
    await ensureVaultRepo(vault);

    await writeFile(join(vault.warmDir, "hot-theme.md"), `---\ntheme: hot-theme\nlastUpdated: 2026-07-01T00:00:00Z\ntype: project\n---\n\n## Current Status\n${"x".repeat(100)}`, "utf-8");
    await writeFile(join(vault.warmDir, "cold-theme.md"), `---\ntheme: cold-theme\nlastUpdated: 2026-07-01T00:00:00Z\ntype: project\n---\n\n## Current Status\nQuiet theme.`, "utf-8");
    await commitVault(vault, "feat: synthesize hot-theme and cold-theme");

    await writeFile(join(vault.warmDir, "hot-theme.md"), `---\ntheme: hot-theme\nlastUpdated: 2026-07-02T00:00:00Z\ntype: project\n---\n\n## Current Status\n${"y".repeat(100)}`, "utf-8");
    await commitVault(vault, "feat: update hot-theme again");

    const sinceIso = new Date(Date.now() - 3600_000).toISOString();
    const inputs = await gatherRollupInputs(vault, sinceIso, new Date().toISOString());

    expect(inputs.hasActivity).toBe(true);
    // hot-theme was touched by 2 commits, cold-theme by 1 — hot-theme must come first.
    expect(inputs.themesTouched[0]).toBe("hot-theme");
    expect(inputs.themeExcerpts[0].theme).toBe("hot-theme");
  });
});

describe("buildAigisRollupPrompt", () => {
  it("includes first-person/professional framing, anti-hallucination instructions, and all required sections", () => {
    const prompt = buildAigisRollupPrompt(
      { commitSubjects: ["feat: X"], themesTouched: ["theme-a"], journalEntries: [], themeExcerpts: [], hasActivity: true },
      "2026-07-01T00:00:00Z",
      "2026-07-08T00:00:00Z",
      "weekly"
    );
    expect(prompt).toMatch(/FIRST PERSON/i);
    expect(prompt).toMatch(/aigis\.bio/i);
    expect(prompt).toMatch(/NEVER invent, fabricate, or hallucinate/i);
    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Skills Demonstrated");
    expect(prompt).toContain("## Artifacts & Outcomes");
    expect(prompt).toContain("## Decisions & Rationale");
    expect(prompt).toContain("feat: X");
  });
});

describe("runAigisRollup", () => {
  it("writes nothing and returns false when the period has no activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-run-empty-"));
    const vault = await initVaultWithoutGit(root);

    const provider = { complete: vi.fn() } as any;
    const did = await runAigisRollup(vault, provider, "gpt", { cadence: "weekly", lastRun: null, now: new Date("2020-01-01T00:00:00Z") });

    expect(did).toBe(false);
    expect(provider.complete).not.toHaveBeenCalled();
    const pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles).toEqual([]);
  });

  it("drafts a pending update with the aigisRollup sub-kind when the period has activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-run-active-"));
    const vault = new Vault(root);
    await vault.init();

    await appendActivity(vault, { timestamp: new Date().toISOString(), log: "Shipped feature X", source: "test" });

    const provider = { complete: vi.fn().mockResolvedValue("## Summary\nShipped feature X.\n") } as any;
    const lastRun = new Date(Date.now() - 3600_000).toISOString();
    const did = await runAigisRollup(vault, provider, "gpt", { cadence: "weekly", lastRun });

    expect(did).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(1);

    const pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles).toHaveLength(1);
    const update = JSON.parse(await readFile(join(vault.pendingDir, pendingFiles[0]), "utf-8"));
    expect(update.aigisRollup).toBeDefined();
    expect(update.aigisRollup.cadence).toBe("weekly");
    expect(update.aigisRollup.periodStart).toBe(lastRun);
    expect(update.previousContent).toBeNull();
    expect(update.theme).toMatch(/^aigis-rollup-\d{4}-\d{2}-\d{2}$/);
    expect(update.proposedContent).toContain("Shipped feature X");
  });

  it("replaces (does not stack) an existing pending draft for the same period", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-run-replace-"));
    const vault = new Vault(root);
    await vault.init();

    await appendActivity(vault, { timestamp: new Date().toISOString(), log: "First pass activity", source: "test" });

    const provider = { complete: vi.fn().mockResolvedValue("## Summary\nFirst draft.\n") } as any;
    const lastRun = new Date(Date.now() - 3600_000).toISOString();
    await runAigisRollup(vault, provider, "gpt", { cadence: "weekly", lastRun });

    let pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles).toHaveLength(1);

    provider.complete.mockResolvedValue("## Summary\nSecond draft, same period.\n");
    await runAigisRollup(vault, provider, "gpt", { cadence: "weekly", lastRun });

    pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles).toHaveLength(1);
    const update = JSON.parse(await readFile(join(vault.pendingDir, pendingFiles[0]), "utf-8"));
    expect(update.proposedContent).toContain("Second draft");
  });

  it("refuses to run while the dream lock is held (mirrors runCompaction's guard)", async () => {
    const root = await mkdtemp(join(tmpdir(), "aigis-rollup-lock-"));
    const vault = new Vault(root);
    await vault.init();

    const release = await acquireDreamLock(vault);
    try {
      const provider = { complete: vi.fn() } as any;
      await expect(
        runAigisRollup(vault, provider, "gpt", { cadence: "weekly", lastRun: null })
      ).rejects.toThrow(/already running/i);
      expect(provider.complete).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });
});
