import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vault, writeTheme, searchIndex, rebuildIndex } from "../../core/dist/index.js";
import type { PendingUpdate, LlmProvider } from "../../core/dist/index.js";
import {
  gateOnStaleness,
  approvePendingUpdate,
  approvePendingUpdatesBatch,
  regeneratePendingUpdate,
} from "../src/lib/approve.js";

const execFileAsync = promisify(execFile);

async function gitLog(vault: Vault): Promise<string[]> {
  const gitDir = join(vault.root, "vault");
  const { stdout } = await execFileAsync("git", ["-C", gitDir, "log", "--format=%s"]);
  return stdout.trim().split("\n").filter(Boolean);
}

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
    batchId: overrides.batchId,
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

  it("returns 404 (not 500) when the pending file doesn't exist (M6)", async () => {
    const outcome = await approvePendingUpdate(tempDir, pendingDir, "does-not-exist", undefined);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
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

  it("commits the write to the vault git repo on successful approve", async () => {
    await writeTheme(vault, "project-git", "## Current Status\n\nOriginal.");
    const update = basePending({
      id: "git-commit-id",
      theme: "project-git",
      proposedContent: "## Current Status\n\nUpdated via approve.",
      previousContent: "## Current Status\n\nOriginal.",
      batchId: "batch-123",
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "git-commit-id", undefined);
    expect(outcome.ok).toBe(true);

    const log = await gitLog(vault);
    expect(log.some((subject) => subject.startsWith("approve(project-git):") && subject.includes("batch=batch-123"))).toBe(true);
  });

  it("uses a merge(<src>-><dst>) commit message for structural lintFix merges", async () => {
    await writeTheme(vault, "project-src", "## Current Status\n\nSrc content.");
    await writeTheme(vault, "project-dst", "## Current Status\n\nDst content.");
    const update = basePending({
      id: "merge-id",
      theme: "project-src",
      lintFix: "merge",
      related: ["project-dst"],
      previousContent: null,
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "merge-id", undefined);
    expect(outcome.ok).toBe(true);

    const log = await gitLog(vault);
    expect(log.some((subject) => subject.startsWith("merge(project-src->project-dst)"))).toBe(true);
  });

  it("approvePendingUpdatesBatch lands a whole batch as ONE commit listing every theme", async () => {
    await writeTheme(vault, "project-alpha", "## Current Status\n\nAlpha original.");
    await writeTheme(vault, "project-beta", "## Current Status\n\nBeta original.");
    const before = await gitLog(vault);

    await writePendingFile(
      pendingDir,
      basePending({
        id: "batch-alpha",
        theme: "project-alpha",
        proposedContent: "## Current Status\n\nAlpha updated.",
        previousContent: "## Current Status\n\nAlpha original.",
        batchId: "dream-batch-1",
      })
    );
    await writePendingFile(
      pendingDir,
      basePending({
        id: "batch-beta",
        theme: "project-beta",
        proposedContent: "## Current Status\n\nBeta updated.",
        previousContent: "## Current Status\n\nBeta original.",
        batchId: "dream-batch-1",
      })
    );

    const results = await approvePendingUpdatesBatch(tempDir, pendingDir, ["batch-alpha", "batch-beta"]);
    expect(results.every((r) => r.outcome.ok)).toBe(true);

    const after = await gitLog(vault);
    // Exactly one new commit for the whole batch, not one per item.
    expect(after.length).toBe(before.length + 1);
    const subject = after[0];
    expect(subject).toContain("project-alpha");
    expect(subject).toContain("project-beta");
    expect(subject).toContain("batch=dream-batch-1");
  });

  it("approvePendingUpdatesBatch still writes and reports a stale item, excluding it from the commit message", async () => {
    await writeTheme(vault, "project-gamma", "## Current Status\n\nGamma CHANGED on disk.");
    await writeTheme(vault, "project-delta", "## Current Status\n\nDelta original.");

    await writePendingFile(
      pendingDir,
      basePending({
        id: "batch-stale-gamma",
        theme: "project-gamma",
        proposedContent: "## Current Status\n\nGamma updated.",
        previousContent: "## Current Status\n\nGamma original (stale snapshot).",
        batchId: "dream-batch-2",
      })
    );
    await writePendingFile(
      pendingDir,
      basePending({
        id: "batch-ok-delta",
        theme: "project-delta",
        proposedContent: "## Current Status\n\nDelta updated.",
        previousContent: "## Current Status\n\nDelta original.",
        batchId: "dream-batch-2",
      })
    );

    const results = await approvePendingUpdatesBatch(tempDir, pendingDir, ["batch-stale-gamma", "batch-ok-delta"]);
    const staleResult = results.find((r) => r.id === "batch-stale-gamma");
    const okResult = results.find((r) => r.id === "batch-ok-delta");
    expect(staleResult?.outcome.ok).toBe(false);
    expect(okResult?.outcome.ok).toBe(true);

    const log = await gitLog(vault);
    const subject = log[0];
    expect(subject).toContain("project-delta");
    expect(subject).not.toContain("project-gamma");
  });

  it("approvePendingUpdatesBatch is a clean no-op commit-wise when every item fails", async () => {
    await writeTheme(vault, "project-epsilon", "## Current Status\n\nChanged on disk.");
    await writePendingFile(
      pendingDir,
      basePending({
        id: "batch-all-stale",
        theme: "project-epsilon",
        proposedContent: "## Current Status\n\nUpdated.",
        previousContent: "## Current Status\n\nStale snapshot.",
      })
    );
    const before = await gitLog(vault);

    const results = await approvePendingUpdatesBatch(tempDir, pendingDir, ["batch-all-stale"]);
    expect(results[0]?.outcome.ok).toBe(false);

    const after = await gitLog(vault);
    expect(after.length).toBe(before.length);
  });

  it("is searchable immediately after approve — the search index is updated in the same call", async () => {
    await writeTheme(vault, "project-zeta", "## Current Status\n\nZeta original.");
    await rebuildIndex(vault); // seed the index with the pre-approve content

    const update = basePending({
      id: "index-fresh-id",
      theme: "project-zeta",
      proposedContent: "## Current Status\n\nZeta now mentions a brand new gizmoquartz widget.",
      previousContent: "## Current Status\n\nZeta original.",
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "index-fresh-id", undefined);
    expect(outcome.ok).toBe(true);

    // No manual rebuild in between — approve itself must have refreshed the index.
    const results = await searchIndex(vault, "gizmoquartz");
    expect(results.some((r) => r.theme === "project-zeta")).toBe(true);
  });

  it("removes a merged/deleted theme's chunks from the index and re-indexes the canonical theme", async () => {
    await writeTheme(vault, "project-eta-src", "## Current Status\n\nEta source has a uniquefrobnitz marker.");
    await writeTheme(vault, "project-eta-dst", "## Current Status\n\nEta destination content.");
    await rebuildIndex(vault);

    const update = basePending({
      id: "merge-index-id",
      theme: "project-eta-src",
      lintFix: "merge",
      related: ["project-eta-dst"],
      previousContent: null,
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "merge-index-id", undefined);
    expect(outcome.ok).toBe(true);

    // The source theme is gone — searching its distinctive content should no
    // longer surface "project-eta-src" (its chunks moved into the canonical
    // theme's content, which mergeThemes already handles on disk).
    const results = await searchIndex(vault, "uniquefrobnitz");
    expect(results.some((r) => r.theme === "project-eta-src")).toBe(false);
  });

  it("re-indexes a THIRD theme whose [[wiki-link]] mergeThemes rewrote, not just the merged/canonical pair", async () => {
    // mergeThemes rewrites [[source]] -> [[canonical]] across every OTHER
    // warm file too (see merge-themes.ts's rewriteLinks) — a third theme
    // that merely links to the merged-away theme gets its on-disk content
    // changed even though it isn't part of the merge pair itself. The
    // search index must reflect that changed content, not just the
    // source/canonical pair.
    await writeTheme(vault, "project-theta-src", "## Current Status\n\nTheta source content.");
    await writeTheme(vault, "project-theta-dst", "## Current Status\n\nTheta destination content.");
    await writeTheme(
      vault,
      "project-theta-third",
      "## Current Status\n\nSee [[project-theta-src]] for zzyzxquokka details.",
    );
    await rebuildIndex(vault);

    const update = basePending({
      id: "merge-third-id",
      theme: "project-theta-src",
      lintFix: "merge",
      related: ["project-theta-dst"],
      previousContent: null,
    });
    await writePendingFile(pendingDir, update);

    const outcome = await approvePendingUpdate(tempDir, pendingDir, "merge-third-id", undefined);
    expect(outcome.ok).toBe(true);

    // The third theme's on-disk link text now reads [[project-theta-dst]] —
    // searching for that new link text should surface project-theta-third,
    // proving its stale index entry (still referencing project-theta-src)
    // was refreshed by the merge, not left behind.
    const results = await searchIndex(vault, "project-theta-dst");
    expect(results.some((r) => r.theme === "project-theta-third")).toBe(true);
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
