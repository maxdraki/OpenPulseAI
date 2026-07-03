import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "../../core/dist/index.js";
import type { PendingUpdate, LlmProvider } from "../../core/dist/index.js";
import {
  gateOnStaleness,
  approvePendingUpdate,
  regeneratePendingUpdate,
} from "../src/lib/approve.js";

async function writePendingFile(pendingDir: string, update: PendingUpdate): Promise<void> {
  await writeFile(join(pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
}

function basePending(overrides: Partial<PendingUpdate> & { id: string; theme: string }): PendingUpdate {
  return {
    id: overrides.id,
    theme: overrides.theme,
    proposedContent: overrides.proposedContent ?? "## Current Status\n\nProposed content.",
    previousContent: overrides.previousContent ?? null,
    entries: overrides.entries ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    status: overrides.status ?? "pending",
    type: overrides.type,
    lintFix: overrides.lintFix,
    related: overrides.related,
    schemaEvolution: overrides.schemaEvolution,
    compactionType: overrides.compactionType,
    querybackSource: overrides.querybackSource,
  };
}

describe("gateOnStaleness", () => {
  it("proceeds when previousContent matches current content", () => {
    const result = gateOnStaleness("## Body\nsame", "## Body\nsame");
    expect(result).toEqual({ proceed: true, stale: false, legacy: false });
  });

  it("blocks when previousContent diverges from current content", () => {
    const result = gateOnStaleness("## Body\nold", "## Body\nnew");
    expect(result).toEqual({ proceed: false, stale: true, legacy: false });
  });

  it("proceeds (with legacy flag) when previousContent is absent", () => {
    const result = gateOnStaleness(undefined, "## Body\nanything");
    expect(result).toEqual({ proceed: true, stale: false, legacy: true });
  });
});

describe("approvePendingUpdate", () => {
  let tempDir: string;
  let vault: Vault;
  let pendingDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-approve-"));
    vault = new Vault(tempDir);
    await vault.init();
    pendingDir = vault.pendingDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writes the theme file when previousContent matches the current on-disk page", async () => {
    await writeTheme(vault, "project-a", "## Current Status\n\nOriginal content.");
    const update = basePending({
      id: "match-id",
      theme: "project-a",
      proposedContent: "## Current Status\n\nUpdated content.",
      previousContent: "## Current Status\n\nOriginal content.",
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "match-id", undefined);

    expect(outcome.ok).toBe(true);
    const written = await readFile(vault.themeFilePath("project-a"), "utf-8");
    expect(written).toContain("Updated content.");

    // Pending file removed on success.
    const files = await readdir(pendingDir);
    expect(files).not.toContain("match-id.json");
  });

  it("returns 409 stale and leaves the theme file untouched when previousContent has diverged", async () => {
    await writeTheme(vault, "project-b", "## Current Status\n\nHand-edited content.");
    const update = basePending({
      id: "stale-id",
      theme: "project-b",
      proposedContent: "## Current Status\n\nProposed content based on old snapshot.",
      previousContent: "## Current Status\n\nOriginal content before the hand edit.",
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "stale-id", undefined);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.error).toBe("stale");
      expect(outcome.stale).toBe(true);
      expect(outcome.theme).toBe("project-b");
    }

    // File on disk is untouched — the hand edit survives.
    const written = await readFile(vault.themeFilePath("project-b"), "utf-8");
    expect(written).toContain("Hand-edited content.");

    // Pending file is preserved (not deleted) so it can be regenerated.
    const files = await readdir(pendingDir);
    expect(files).toContain("stale-id.json");
  });

  it("allows approval when previousContent is absent (legacy pending record), with a warning", async () => {
    await writeTheme(vault, "project-c", "## Current Status\n\nSome content that changed since a legacy pending was created.");
    const update = basePending({ id: "legacy-id", theme: "project-c", proposedContent: "## Current Status\n\nLegacy proposed content." });
    // Simulate an old record predating staleness tracking: previousContent field entirely absent.
    const raw = JSON.stringify(update, null, 2).replace(/,\s*"previousContent":\s*null/, "");
    await writeFile(join(pendingDir, "legacy-id.json"), raw, "utf-8");
    expect(JSON.parse(raw).previousContent).toBeUndefined();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await approvePendingUpdate(tempDir, pendingDir, "legacy-id", undefined);
    warnSpy.mockRestore();

    expect(outcome.ok).toBe(true);
    const written = await readFile(vault.themeFilePath("project-c"), "utf-8");
    expect(written).toContain("Legacy proposed content.");
  });

  it("brand-new theme (missing file) with empty previousContent is not stale", async () => {
    const update = basePending({ id: "new-theme-id", theme: "brand-new-theme", previousContent: null });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "new-theme-id", undefined);
    expect(outcome.ok).toBe(true);
  });

  it("batch approve: one stale item is skipped while others are written and reported", async () => {
    await writeTheme(vault, "project-d", "## Current Status\n\nD original.");
    await writeTheme(vault, "project-e", "## Current Status\n\nE original.");

    const okUpdate = basePending({
      id: "batch-ok",
      theme: "project-d",
      proposedContent: "## Current Status\n\nD updated.",
      previousContent: "## Current Status\n\nD original.",
    });
    const staleUpdate = basePending({
      id: "batch-stale",
      theme: "project-e",
      proposedContent: "## Current Status\n\nE updated.",
      previousContent: "## Current Status\n\nE stale snapshot (page moved on).",
    });
    await writePendingFile(pendingDir, okUpdate);
    await writePendingFile(pendingDir, staleUpdate);

    const results = await Promise.all([
      approvePendingUpdate(tempDir, pendingDir, "batch-ok", undefined),
      approvePendingUpdate(tempDir, pendingDir, "batch-stale", undefined),
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) expect(results[1].stale).toBe(true);

    const dWritten = await readFile(vault.themeFilePath("project-d"), "utf-8");
    expect(dWritten).toContain("D updated.");
    const eWritten = await readFile(vault.themeFilePath("project-e"), "utf-8");
    expect(eWritten).toContain("E original."); // untouched

    const files = await readdir(pendingDir);
    expect(files).not.toContain("batch-ok.json");
    expect(files).toContain("batch-stale.json");
  });

  it("skips the staleness gate for structural lintFix kinds (merge/delete/rename)", async () => {
    await writeTheme(vault, "project-f", "## Current Status\n\nF content.");
    const update = basePending({
      id: "delete-id",
      theme: "project-f",
      lintFix: "delete",
      previousContent: null, // structural fixes never carry a meaningful snapshot
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "delete-id", undefined);
    expect(outcome.ok).toBe(true);
  });
});

describe("regeneratePendingUpdate", () => {
  let tempDir: string;
  let vault: Vault;
  let pendingDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-regenerate-"));
    vault = new Vault(tempDir);
    await vault.init();
    pendingDir = vault.pendingDir;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("regenerates a stale pending against the current page using a mocked LLM, with previousContent = current page", async () => {
    await writeTheme(vault, "project-g", "## Current Status\n\nCurrent page content (changed since proposal).");
    const staleUpdate = basePending({
      id: "stale-g",
      theme: "project-g",
      proposedContent: "## Current Status\n\nStale proposal with new info.",
      previousContent: "## Current Status\n\nOld snapshot.",
    });
    await writePendingFile(pendingDir, staleUpdate);

    const mockProvider: LlmProvider = {
      complete: vi.fn().mockResolvedValue("## Current Status\n\nMerged: current page content plus new info from the stale proposal."),
    };

    const outcome = await regeneratePendingUpdate(tempDir, pendingDir, "stale-g", mockProvider, "test-model");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.update.previousContent).toContain("Current page content (changed since proposal)");
      expect(outcome.update.proposedContent).toContain("Merged:");
      expect(outcome.update.id).not.toBe("stale-g");
    }

    const files = await readdir(pendingDir);
    expect(files).not.toContain("stale-g.json");
  });
});
