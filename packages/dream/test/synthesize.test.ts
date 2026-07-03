import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { ClassificationResult, LlmProvider, PendingUpdate } from "@openpulse/core";
import { synthesizeToPending, parseMetaBlock, stripMetaBlock, regenerateStaleUpdate } from "../src/synthesize.js";

function mockProvider(responseText: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("synthesizeToPending", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-synth-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates pending update files", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Refactored login page" },
        themes: ["project-auth"],
        confidence: 0.95,
      },
    ];

    const provider = mockProvider("## Current Status\n\nLogin page refactored.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    const pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles.length).toBe(1);
    expect(pendingFiles[0]).toMatch(/\.json$/);
  });

  it("includes existing warm content in LLM prompt", async () => {
    await writeTheme(vault, "project-auth", "OAuth integration pending.");

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T14:00:00Z", log: "OAuth completed" },
        themes: ["project-auth"],
        confidence: 0.9,
      },
    ];

    const provider = mockProvider("## Current Status\n\nOAuth completed.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("OAuth integration pending"),
      })
    );
  });

  it("groups entries by theme and creates one pending update per theme", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Login page refactored" },
        themes: ["project-auth", "frontend"],
        confidence: 0.95,
      },
      {
        entry: { timestamp: "2026-04-03T11:00:00Z", log: "Added unit tests" },
        themes: ["project-auth"],
        confidence: 0.9,
      },
    ];

    const provider = mockProvider("## Current Status\n\nWork done.");
    const results = await synthesizeToPending(vault, classified, provider, "test-model");

    // Should create two pending updates: one for project-auth, one for frontend
    expect(results.length).toBe(2);
    const themeNames = results.map((r) => r.theme).sort();
    expect(themeNames).toEqual(["frontend", "project-auth"]);

    // All updates share the same batchId
    expect(results[0].batchId).toBeDefined();
    expect(results[0].batchId).toBe(results[1].batchId);
  });

  it("includes cross-reference instruction in LLM prompt", async () => {
    await writeTheme(vault, "other-theme", "Some other theme content.");

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Work on project-auth" },
        themes: ["project-auth"],
        confidence: 0.95,
      },
    ];

    const provider = mockProvider("## Current Status\n\nDone.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Other themes in the wiki"),
      })
    );
  });

  it("runs two LLM calls per entry for concept pages (pass 1 + pass 2)", async () => {
    const provider = {
      complete: vi.fn()
        .mockResolvedValueOnce('[{"claim":"X is a pattern","sourceId":"2026-04-17-github-activity","confidence":"high"}]')
        .mockResolvedValueOnce(
          "## Definition\nX is a pattern. ^[src:2026-04-17-github-activity]\n## Key Claims\n## Related Concepts\n## Sources"
        ),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: {
          timestamp: "2026-04-17T00:00:00Z",
          log: "X is a pattern used in Y.",
          source: "github-activity",
        },
        themes: ["x-pattern"],
        confidence: 0.95,
      },
    ];

    const pending = await synthesizeToPending(
      vault,
      classified,
      provider,
      "gpt",
      { "x-pattern": "concept" }
    );

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
    expect(pending[0].proposedContent).toContain("X is a pattern");

    const facts = await readFile(
      join(vault.warmDir, "_facts", "x-pattern.jsonl"),
      "utf-8"
    );
    expect(facts).toContain("X is a pattern");
    expect(facts).toContain("2026-04-17-github-activity");
  });

  it("runs two LLM calls per entry for entity pages (pass 1 + pass 2)", async () => {
    const provider = {
      complete: vi.fn()
        .mockResolvedValueOnce('[{"claim":"Alice is an engineer","sourceId":"2026-04-17-github-activity","confidence":"high"}]')
        .mockResolvedValueOnce(
          "## Overview\nAlice is an engineer. ^[src:2026-04-17-github-activity]\n## Interactions\n## Sources"
        ),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: {
          timestamp: "2026-04-17T00:00:00Z",
          log: "Met with Alice about the project.",
          source: "github-activity",
        },
        themes: ["alice"],
        confidence: 0.95,
      },
    ];

    await synthesizeToPending(vault, classified, provider, "gpt", { alice: "entity" });

    expect(provider.complete).toHaveBeenCalledTimes(2);

    const facts = await readFile(
      join(vault.warmDir, "_facts", "alice.jsonl"),
      "utf-8"
    );
    expect(facts).toContain("Alice is an engineer");
  });

  it("skips two-pass for project type (single LLM call)", async () => {
    const provider = {
      complete: vi
        .fn()
        .mockResolvedValue(
          "## Current Status\nProgress.\n## Activity Log\n### 2026-04-17\n- Change."
        ),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: {
          timestamp: "2026-04-17T00:00:00Z",
          log: "Did something",
          source: "github-activity",
        },
        themes: ["my-project"],
        confidence: 0.95,
      },
    ];

    await synthesizeToPending(vault, classified, provider, "gpt", {
      "my-project": "project",
    });

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("writes 'No durable claims yet.'-style output gracefully when pass 1 returns []", async () => {
    const provider = {
      complete: vi.fn()
        .mockResolvedValueOnce("[]")
        .mockResolvedValueOnce(
          "## Definition\nNo durable claims yet.\n## Key Claims\n## Related Concepts\n## Sources"
        ),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: {
          timestamp: "2026-04-17T00:00:00Z",
          log: "Ambient mention with no facts.",
          source: "github-activity",
        },
        themes: ["empty-concept"],
        confidence: 0.9,
      },
    ];

    const pending = await synthesizeToPending(
      vault,
      classified,
      provider,
      "gpt",
      { "empty-concept": "concept" }
    );

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(pending[0].proposedContent).toContain("No durable claims yet");
  });

  it("skips re-extracting a duplicate fact from a later run on the same theme", async () => {
    await mkdir(join(vault.warmDir, "_facts"), { recursive: true });
    // Legacy line (no "id" field) — its id is computed on read from
    // claim + sourceId, so it must dedupe against the case/punctuation
    // variant pass 1 re-extracts below.
    await writeFile(
      join(vault.warmDir, "_facts", "dedupe-theme.jsonl"),
      JSON.stringify({ claim: "X uses SQLite.", sourceId: "2026-04-17-github-activity", confidence: "high", extractedAt: "2026-04-17T00:00:00Z" }) + "\n",
      "utf-8"
    );

    const provider = {
      complete: vi.fn()
        // Pass 1 re-extracts the SAME claim (case/punctuation-variant) from the same sourceId.
        .mockResolvedValueOnce('[{"claim":"x   uses sqlite!!","sourceId":"2026-04-17-github-activity","confidence":"high"}]')
        .mockResolvedValueOnce("## Definition\nX uses SQLite. ^[src:2026-04-17-github-activity]"),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-17T00:00:00Z", log: "X uses SQLite.", source: "github-activity" },
        themes: ["dedupe-theme"],
        confidence: 0.9,
      },
    ];

    await synthesizeToPending(vault, classified, provider, "gpt", { "dedupe-theme": "concept" });

    const factsText = await readFile(join(vault.warmDir, "_facts", "dedupe-theme.jsonl"), "utf-8");
    const lines = factsText.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1); // the duplicate was skipped, not appended again
  });

  it("reports fact-hygiene counts via onFactHygiene for a concept theme (mirrors onPatchOutcome)", async () => {
    await mkdir(join(vault.warmDir, "_facts"), { recursive: true });
    await writeFile(
      join(vault.warmDir, "_facts", "hygiene-theme.jsonl"),
      JSON.stringify({ claim: "X uses SQLite.", sourceId: "2026-04-17-github-activity", confidence: "high", extractedAt: "2026-04-17T00:00:00Z" }) + "\n",
      "utf-8"
    );

    const provider = {
      complete: vi.fn()
        // Pass 1 re-extracts the SAME claim (duplicate, skipped) — matches
        // the "skips re-extracting a duplicate fact" test above.
        .mockResolvedValueOnce('[{"claim":"x   uses sqlite!!","sourceId":"2026-04-17-github-activity","confidence":"high"}]')
        .mockResolvedValueOnce("## Definition\nX uses SQLite. ^[src:2026-04-17-github-activity]"),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-17T00:00:00Z", log: "X uses SQLite.", source: "github-activity" },
        themes: ["hygiene-theme"],
        confidence: 0.9,
      },
    ];

    const onFactHygiene = vi.fn();
    await synthesizeToPending(vault, classified, provider, "gpt", { "hygiene-theme": "concept" }, { onFactHygiene });

    expect(onFactHygiene).toHaveBeenCalledWith("hygiene-theme", { added: 0, skipped: 1, superseded: 0 });
  });

  it("applies supersession signaled by pass-1 extraction and excludes the superseded fact from the pass-2 prompt", async () => {
    await mkdir(join(vault.warmDir, "_facts"), { recursive: true });
    await writeFile(
      join(vault.warmDir, "_facts", "supersede-theme.jsonl"),
      JSON.stringify({ id: "old-fact-id", claim: "X uses SQLite.", sourceId: "2026-04-01-github-activity", confidence: "high", extractedAt: "2026-04-01T00:00:00Z" }) + "\n",
      "utf-8"
    );

    const provider = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          '[{"claim":"X migrated to Postgres.","sourceId":"2026-04-20-github-activity","confidence":"high","supersedes":["old-fact-id"]}]'
        )
        .mockResolvedValueOnce("## Definition\nX migrated to Postgres. ^[src:2026-04-20-github-activity]"),
    } as unknown as LlmProvider;

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-20T00:00:00Z", log: "X migrated to Postgres.", source: "github-activity" },
        themes: ["supersede-theme"],
        confidence: 0.9,
      },
    ];

    await synthesizeToPending(vault, classified, provider, "gpt", { "supersede-theme": "concept" });

    // Pass-1 extraction prompt included the active-facts context.
    const extractionPrompt = (provider.complete as any).mock.calls[0][0].prompt as string;
    expect(extractionPrompt).toContain("old-fact-id");
    expect(extractionPrompt).toContain("X uses SQLite.");

    // Pass-2 synthesis prompt must NOT include the now-superseded fact's claim.
    const synthesisPrompt = (provider.complete as any).mock.calls[1][0].prompt as string;
    expect(synthesisPrompt).toContain("X migrated to Postgres.");
    expect(synthesisPrompt).not.toContain("X uses SQLite.");

    // The fact store retains the superseded line as history (never deleted).
    const factsText = await readFile(join(vault.warmDir, "_facts", "supersede-theme.jsonl"), "utf-8");
    const facts = factsText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(facts).toHaveLength(2);
    const old = facts.find((f) => f.id === "old-fact-id");
    expect(old.supersededBy).toBeTruthy();
    expect(old.supersededAt).toBeTruthy();
  });

  it("parses LLM <meta> block into projectStatus and strips it from content", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
        themes: ["openpulse"],
        confidence: 0.95,
        skills: ["typescript", "system-design"],
      },
    ];

    const provider = mockProvider(
      `<meta>\nstatus: blocked\nreason: waiting on design review\n</meta>\n\n## Current Status\n\nBody content.\n## Skills Demonstrated\n- typescript ^[src:2026-04-18-github-activity]\n`
    );
    const pending = await synthesizeToPending(vault, classified, provider, "gpt", { openpulse: "project" });

    expect(pending).toHaveLength(1);
    expect(pending[0].proposedContent.startsWith("<meta>")).toBe(false);
    expect(pending[0].proposedContent).toContain("## Current Status");
    expect(pending[0].projectStatus).toBe("blocked");
    expect(pending[0].projectStatusReason).toBe("waiting on design review");
    expect(pending[0].skills).toEqual(expect.arrayContaining(["typescript", "system-design"]));
  });

  it("tolerates a project synthesis response with no <meta> block", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
        themes: ["plain-project"],
        confidence: 0.95,
      },
    ];
    const provider = mockProvider("## Current Status\n\nBody.\n");
    const pending = await synthesizeToPending(vault, classified, provider, "gpt", { "plain-project": "project" });

    expect(pending).toHaveLength(1);
    expect(pending[0].projectStatus).toBeUndefined();
    expect(pending[0].projectStatusReason).toBeUndefined();
    expect(pending[0].proposedContent).toContain("## Current Status");
  });

  describe("per-theme failure isolation", () => {
    it("skips a failing theme, keeps the succeeding one's pending, and reports the failure", async () => {
      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work on theme A", source: "github-activity" },
          themes: ["theme-a"],
          confidence: 0.95,
        },
        {
          entry: { timestamp: "2026-04-18T11:00:00Z", log: "Work on theme B", source: "github-activity" },
          themes: ["theme-b"],
          confidence: 0.95,
        },
      ];

      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes('for "theme-b"')) throw new Error("LLM down for theme-b");
          return "## Current Status\n\nDone.";
        }),
      };

      const onThemeFailure = vi.fn();
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", undefined, {
        onThemeFailure,
      });

      expect(pending.map((p) => p.theme)).toEqual(["theme-a"]);
      expect(onThemeFailure).toHaveBeenCalledTimes(1);
      expect(onThemeFailure).toHaveBeenCalledWith("theme-b", expect.any(Error));

      // theme-a's pending file was actually written to disk despite theme-b failing.
      const pendingFiles = await readdir(vault.pendingDir);
      expect(pendingFiles).toHaveLength(1);
    });

    it("continues past a failing theme to synthesize a later one in the same batch", async () => {
      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work on theme B (fails)", source: "github-activity" },
          themes: ["theme-b"],
          confidence: 0.95,
        },
        {
          entry: { timestamp: "2026-04-18T11:00:00Z", log: "Work on theme C (succeeds)", source: "github-activity" },
          themes: ["theme-c"],
          confidence: 0.95,
        },
      ];

      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes('for "theme-b"')) throw new Error("LLM down for theme-b");
          return "## Current Status\n\nDone.";
        }),
      };

      const pending = await synthesizeToPending(vault, classified, provider, "test-model");
      expect(pending.map((p) => p.theme)).toEqual(["theme-c"]);
    });
  });

  describe("truncation guard", () => {
    it("refuses a pending update when the provider reports the completion was truncated, defers the theme via onThemeFailure, and leaves other themes unaffected", async () => {
      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work on theme A", source: "github-activity" },
          themes: ["theme-a"],
          confidence: 0.95,
        },
        {
          entry: { timestamp: "2026-04-18T11:00:00Z", log: "Work on theme B", source: "github-activity" },
          themes: ["theme-b"],
          confidence: 0.95,
        },
      ];

      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes('for "theme-a"')) return "## Current Status\n\nTruncated content";
          return "## Current Status\n\nDone.";
        }),
        wasLastCompletionTruncated: vi.fn(),
      };
      // Simulate: theme-a's completion is truncated, theme-b's is not.
      let callCount = 0;
      (provider.complete as ReturnType<typeof vi.fn>).mockImplementation(async (params: { prompt: string }) => {
        callCount++;
        if (params.prompt.includes('for "theme-a"')) {
          (provider.wasLastCompletionTruncated as ReturnType<typeof vi.fn>).mockReturnValue(true);
          return "## Current Status\n\nTruncated content";
        }
        (provider.wasLastCompletionTruncated as ReturnType<typeof vi.fn>).mockReturnValue(false);
        return "## Current Status\n\nDone.";
      });

      const onThemeFailure = vi.fn();
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", undefined, {
        onThemeFailure,
      });

      expect(pending.map((p) => p.theme)).toEqual(["theme-b"]);
      expect(onThemeFailure).toHaveBeenCalledTimes(1);
      expect(onThemeFailure).toHaveBeenCalledWith("theme-a", expect.any(Error));

      const pendingFiles = await readdir(vault.pendingDir);
      expect(pendingFiles).toHaveLength(1);
      expect(callCount).toBe(2);
    });
  });

  describe("shrinkage guard", () => {
    it("refuses an update whose proposed content is less than 80% of the existing content's length", async () => {
      const existingContent = "x".repeat(1000);
      await writeTheme(vault, "shrink-theme", existingContent);

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
          themes: ["shrink-theme"],
          confidence: 0.95,
        },
      ];

      // 50% of existing length — should be refused.
      const provider = mockProvider("## Current Status\n\n" + "y".repeat(500 - 20));

      const onThemeFailure = vi.fn();
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", { "shrink-theme": "project" }, {
        onThemeFailure,
      });

      expect(pending).toHaveLength(0);
      expect(onThemeFailure).toHaveBeenCalledWith("shrink-theme", expect.any(Error));

      const pendingFiles = await readdir(vault.pendingDir);
      expect(pendingFiles).toHaveLength(0);
    });

    it("allows an update whose proposed content is 95% of the existing content's length", async () => {
      const existingContent = "x".repeat(1000);
      await writeTheme(vault, "ok-theme", existingContent);

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
          themes: ["ok-theme"],
          confidence: 0.95,
        },
      ];

      // 95% of existing length — should be allowed.
      const provider = mockProvider("y".repeat(950));

      const onThemeFailure = vi.fn();
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", { "ok-theme": "project" }, {
        onThemeFailure,
      });

      expect(pending).toHaveLength(1);
      expect(onThemeFailure).not.toHaveBeenCalled();
    });
  });

  describe("maxTokens computation", () => {
    it("caps maxTokens above the old 4096 ceiling for a large existing page, bounded by 16384", async () => {
      // ~40000 chars ≈ 10000 estimated tokens. Headroom = max(1024, 25% of 10000) = 2500.
      // Expected maxTokens = min(16384, 10000 + 2500) = 12500.
      const existingContent = "x".repeat(40000);
      await writeTheme(vault, "big-theme", existingContent);

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
          themes: ["big-theme"],
          confidence: 0.95,
        },
      ];

      const provider = mockProvider("## Current Status\n\n" + "y".repeat(39000));
      await synthesizeToPending(vault, classified, provider, "test-model", { "big-theme": "project" });

      expect(provider.complete).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: expect.any(Number) })
      );
      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.maxTokens).toBeGreaterThan(4096);
      expect(call.maxTokens).toBeLessThanOrEqual(16384);
      expect(call.maxTokens).toBe(12500);
    });

    it("bounds maxTokens at MAX_SYNTHESIS_OUTPUT_TOKENS (16384) even for an enormous existing page", async () => {
      // ~400000 chars ≈ 100000 estimated tokens — headroom alone would blow past 16384.
      const existingContent = "x".repeat(400000);
      await writeTheme(vault, "huge-theme", existingContent);

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-18T10:00:00Z", log: "Work continues", source: "github-activity" },
          themes: ["huge-theme"],
          confidence: 0.95,
        },
      ];

      const provider = mockProvider("## Current Status\n\n" + "y".repeat(390000));
      await synthesizeToPending(vault, classified, provider, "test-model", { "huge-theme": "project" });

      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.maxTokens).toBe(16384);
    });
  });

  describe("fold at source", () => {
    async function writePending(vault: Vault, update: Partial<PendingUpdate> & { theme: string }): Promise<PendingUpdate> {
      const full: PendingUpdate = {
        id: update.id ?? "existing-pending-id",
        theme: update.theme,
        proposedContent: update.proposedContent ?? "",
        previousContent: update.previousContent ?? null,
        entries: update.entries ?? [],
        createdAt: update.createdAt ?? new Date().toISOString(),
        status: update.status ?? "pending",
        batchId: update.batchId,
        lintFix: update.lintFix,
        compactionType: update.compactionType,
        schemaEvolution: update.schemaEvolution,
        querybackSource: update.querybackSource,
        type: update.type,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(vault.pendingDir, `${full.id}.json`), JSON.stringify(full, null, 2), "utf-8");
      return full;
    }

    it("uses the existing dream-kind pending's proposedContent as the synthesis base, and leaves exactly one pending whose previousContent is the on-disk page", async () => {
      await writeTheme(vault, "project-x", "## Current Status\n\nOriginal on-disk content.");
      const existingPending = await writePending(vault, {
        id: "prior-proposal",
        theme: "project-x",
        proposedContent: "## Current Status\n\nPrior proposal content not yet approved.",
        previousContent: "## Current Status\n\nOriginal on-disk content.",
      });

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-20T10:00:00Z", log: "More work happened", source: "github-activity" },
          themes: ["project-x"],
          confidence: 0.9,
        },
      ];

      const provider = mockProvider("## Current Status\n\nPrior proposal content not yet approved, now with more work happened folded in.");
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", { "project-x": "project" });

      // Prompt was built against the prior proposal's content, not the stale on-disk page.
      expect((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).toContain("Prior proposal content not yet approved");

      // The result's previousContent is the actual on-disk page, not the folded proposal.
      expect(pending[0].previousContent).toBe("## Current Status\n\nOriginal on-disk content.");

      // Exactly one pending remains for the theme — the old one was replaced.
      const files = await readdir(vault.pendingDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      expect(jsonFiles).toHaveLength(1);
      expect(jsonFiles[0]).not.toBe(`${existingPending.id}.json`);
    });

    it("does NOT fold a lintFix-kind pending — synthesizes against the on-disk page instead", async () => {
      await writeTheme(vault, "project-y", "## Current Status\n\nOn-disk content.");
      await writePending(vault, {
        id: "lint-pending",
        theme: "project-y",
        proposedContent: "## Merge proposal\n\nStructural fix, not a content base.",
        previousContent: null,
        lintFix: "dedup-dates",
      });

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-20T10:00:00Z", log: "New activity", source: "github-activity" },
          themes: ["project-y"],
          confidence: 0.9,
        },
      ];

      const provider = mockProvider("## Current Status\n\nOn-disk content, updated.");
      await synthesizeToPending(vault, classified, provider, "test-model", { "project-y": "project" });

      expect((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).toContain("On-disk content.");
      expect((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).not.toContain("Structural fix");

      // The lint pending was left untouched.
      const raw = await readFile(join(vault.pendingDir, "lint-pending.json"), "utf-8");
      expect(JSON.parse(raw).proposedContent).toContain("Structural fix");
    });

    it("ignores a foldable pending that's already stale relative to the on-disk page", async () => {
      await writeTheme(vault, "project-z", "## Current Status\n\nHand-edited on-disk content.");
      await writePending(vault, {
        id: "stale-pending",
        theme: "project-z",
        proposedContent: "## Current Status\n\nStale proposal.",
        previousContent: "## Current Status\n\nDifferent original content.", // no longer matches on-disk
      });

      const classified: ClassificationResult[] = [
        {
          entry: { timestamp: "2026-04-20T10:00:00Z", log: "New activity", source: "github-activity" },
          themes: ["project-z"],
          confidence: 0.9,
        },
      ];

      const provider = mockProvider("## Current Status\n\nHand-edited on-disk content, updated.");
      await synthesizeToPending(vault, classified, provider, "test-model", { "project-z": "project" });

      expect((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).toContain("Hand-edited on-disk content");
      expect((provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt).not.toContain("Stale proposal");
    });
  });

  describe("regenerateStaleUpdate", () => {
    it("produces a replacement pending whose previousContent is the current on-disk page, and removes the stale file", async () => {
      const staleUpdate: PendingUpdate = {
        id: "stale-id",
        theme: "project-r",
        proposedContent: "## Current Status\n\nStale proposal content.",
        previousContent: "## Current Status\n\nOld page content.",
        entries: [],
        createdAt: "2026-01-01T00:00:00Z",
        status: "pending",
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(vault.pendingDir, "stale-id.json"), JSON.stringify(staleUpdate, null, 2), "utf-8");

      const provider = mockProvider("## Current Status\n\nMerged: current page content plus the stale proposal's new information.");
      const currentContent = "## Current Status\n\nCurrent page content that changed after the proposal.";

      const replacement = await regenerateStaleUpdate(vault, staleUpdate, currentContent, provider, "test-model");

      expect(replacement.previousContent).toBe(currentContent);
      expect(replacement.proposedContent).toContain("Merged:");
      expect(replacement.id).not.toBe("stale-id");
      expect(replacement.theme).toBe("project-r");

      const files = await readdir(vault.pendingDir);
      expect(files).toContain(`${replacement.id}.json`);
      expect(files).not.toContain("stale-id.json");
    });

    it("refuses (throws) rather than emit a shrunken merge", async () => {
      const staleUpdate: PendingUpdate = {
        id: "stale-id-2",
        theme: "project-shrink",
        proposedContent: "## Current Status\n\nStale proposal.",
        previousContent: "x".repeat(1000),
        entries: [],
        createdAt: "2026-01-01T00:00:00Z",
        status: "pending",
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(vault.pendingDir, "stale-id-2.json"), JSON.stringify(staleUpdate, null, 2), "utf-8");

      const currentContent = "x".repeat(1000);
      const provider = mockProvider("y".repeat(100)); // way under 80% of 1000 chars

      await expect(
        regenerateStaleUpdate(vault, staleUpdate, currentContent, provider, "test-model")
      ).rejects.toThrow();

      // Stale file untouched — no replacement written.
      const files = await readdir(vault.pendingDir);
      expect(files).toContain("stale-id-2.json");
      expect(files).not.toContain(`${staleUpdate.id}-replacement.json`);
    });
  });

  describe("patch synthesis (append/patch for project pages)", () => {
    function bigExistingPage(): string {
      return (
        "## Current Status\n\n" + "x".repeat(600) + "\n" +
        "## Activity Log\n\n### 2026-04-01\n" + "y".repeat(600) + "\n" +
        "## Skills Demonstrated\n\n" + "z".repeat(600) + "\n"
      );
    }

    const PATCH_MARKER = "SECTION-LEVEL PATCHES";

    function classifiedFor(theme: string): ClassificationResult[] {
      return [
        {
          entry: { timestamp: "2026-04-20T10:00:00Z", log: "New work happened", source: "github-activity" },
          themes: [theme],
          confidence: 0.9,
        },
      ];
    }

    it("uses the patch path for a large multi-section page: one LLM call, untouched sections byte-identical, new content present", async () => {
      await writeTheme(vault, "patch-project", bigExistingPage());

      const opsResponse = '```json\n[{"op":"append_to_section","heading":"Activity Log","content":"### 2026-04-20\\n- New work happened. ^[src:2026-04-20-github-activity]\\n"}]\n```';
      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue(opsResponse) };

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(vault, classifiedFor("patch-project"), provider, "test-model", { "patch-project": "project" }, { onPatchOutcome });

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(onPatchOutcome).toHaveBeenCalledWith("patch-project", "patch");
      expect(pending).toHaveLength(1);
      expect(pending[0].proposedContent).toContain("x".repeat(600)); // untouched section byte-identical
      expect(pending[0].proposedContent).toContain("z".repeat(600)); // untouched section byte-identical
      expect(pending[0].proposedContent).toContain("2026-04-20");
      expect(pending[0].proposedContent).toContain("New work happened");

      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.prompt).toContain(PATCH_MARKER);
      expect(call.maxTokens).toBe(4096);
    });

    it("falls back to whole-page rewrite when the patch call's ops fail to parse", async () => {
      await writeTheme(vault, "patch-fallback-parse", bigExistingPage());

      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes(PATCH_MARKER)) return "not json at all, sorry";
          return "## Current Status\n\nWhole page rewrite. " + "w".repeat(600) + "\n## Activity Log\n\n### 2026-04-20\n- New work happened. " + "v".repeat(600) + "\n## Skills Demonstrated\n\n" + "u".repeat(600) + "\n";
        }),
      };

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(vault, classifiedFor("patch-fallback-parse"), provider, "test-model", { "patch-fallback-parse": "project" }, { onPatchOutcome });

      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(onPatchOutcome).toHaveBeenCalledWith("patch-fallback-parse", "fallback");
      expect(pending[0].proposedContent).toContain("Whole page rewrite.");
    });

    it("falls back to whole-page rewrite when an emitted op is rejected (unknown heading)", async () => {
      await writeTheme(vault, "patch-fallback-reject", bigExistingPage());

      const badOps = '```json\n[{"op":"append_to_section","heading":"Nonexistent Section","content":"x"}]\n```';
      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes(PATCH_MARKER)) return badOps;
          return "## Current Status\n\nWhole page rewrite. " + "w".repeat(600) + "\n## Activity Log\n\n### 2026-04-20\n- New work happened. " + "v".repeat(600) + "\n## Skills Demonstrated\n\n" + "u".repeat(600) + "\n";
        }),
      };

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(vault, classifiedFor("patch-fallback-reject"), provider, "test-model", { "patch-fallback-reject": "project" }, { onPatchOutcome });

      expect(provider.complete).toHaveBeenCalledTimes(2);
      expect(onPatchOutcome).toHaveBeenCalledWith("patch-fallback-reject", "fallback");
      expect(pending[0].proposedContent).toContain("Whole page rewrite.");
    });

    it("falls back to whole-page rewrite when the patch completion was truncated", async () => {
      await writeTheme(vault, "patch-fallback-truncated", bigExistingPage());

      const provider: LlmProvider = {
        complete: vi.fn().mockImplementation(async (params: { prompt: string }) => {
          if (params.prompt.includes(PATCH_MARKER)) return '```json\n[{"op":"append_to_section","heading":"Activity Log","content":"x"}]\n```';
          return "## Current Status\n\nWhole page rewrite. " + "w".repeat(600) + "\n## Activity Log\n\n### 2026-04-20\n- New work happened. " + "v".repeat(600) + "\n## Skills Demonstrated\n\n" + "u".repeat(600) + "\n";
        }),
        wasLastCompletionTruncated: vi.fn().mockImplementation(() => true), // patch call always reports truncated
      };
      // Only the patch call is ever truncated; once we fall back, pretend it stops being truncated
      // for the second call by having the guard re-check after each call.
      let callCount = 0;
      (provider.complete as ReturnType<typeof vi.fn>).mockImplementation(async (params: { prompt: string }) => {
        callCount++;
        if (params.prompt.includes(PATCH_MARKER)) {
          (provider.wasLastCompletionTruncated as ReturnType<typeof vi.fn>).mockReturnValue(true);
          return '```json\n[{"op":"append_to_section","heading":"Activity Log","content":"x"}]\n```';
        }
        (provider.wasLastCompletionTruncated as ReturnType<typeof vi.fn>).mockReturnValue(false);
        return "## Current Status\n\nWhole page rewrite. " + "w".repeat(600) + "\n## Activity Log\n\n### 2026-04-20\n- New work happened. " + "v".repeat(600) + "\n## Skills Demonstrated\n\n" + "u".repeat(600) + "\n";
      });

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(vault, classifiedFor("patch-fallback-truncated"), provider, "test-model", { "patch-fallback-truncated": "project" }, { onPatchOutcome });

      expect(callCount).toBe(2);
      expect(onPatchOutcome).toHaveBeenCalledWith("patch-fallback-truncated", "fallback");
      expect(pending[0].proposedContent).toContain("Whole page rewrite.");
    });

    it("bypasses the patch path entirely for a small/new page (single LLM call, no onPatchOutcome)", async () => {
      const classified = classifiedFor("brand-new-project");
      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue("## Current Status\n\nBrand new project.") };

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(vault, classified, provider, "test-model", { "brand-new-project": "project" }, { onPatchOutcome });

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(onPatchOutcome).not.toHaveBeenCalled();
      expect(pending[0].proposedContent).toContain("Brand new project.");
    });

    // Bodies with many lines: buildOutline's preview only ever shows the first
    // two non-empty lines, so a line far past that (e.g. "...line 19") only
    // ends up in the prompt if the section's FULL text was selected as
    // relevant context — not merely from the outline.
    function manyLines(prefix: string, count: number): string {
      return Array.from({ length: count }, (_, i) => `- ${prefix} line ${i}: ${"x".repeat(30)}`).join("\n");
    }

    function bigSourceSummaryPage(): string {
      return (
        "## Source\n\n" + "s".repeat(600) + "\n" +
        "## Key Takeaways\n\n" + manyLines("takeaway", 20) + "\n" +
        "## Referenced In\n\n" + manyLines("reference", 20) + "\n"
      );
    }

    it("includes the full text of Key Takeaways and Referenced In in the prompt for a source-summary page", async () => {
      await writeTheme(vault, "source-doc", bigSourceSummaryPage());

      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue("[]") };
      await synthesizeToPending(vault, classifiedFor("source-doc"), provider, "test-model", { "source-doc": "source-summary" });

      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Lines well past the outline's 2-line preview cap — only present if the
      // full section text was included as relevant context.
      expect(call.prompt).toContain("takeaway line 19");
      expect(call.prompt).toContain("reference line 19");
      expect(call.prompt).toContain(PATCH_MARKER);
    });

    function bigRenamedStatusPage(): string {
      return (
        "## Status Overview\n\n" + manyLines("status", 20) + "\n" +
        "## Activity Log\n\n### 2026-04-01\n" + manyLines("activity", 20) + "\n" +
        "## Skills Demonstrated\n\n" + "z".repeat(600) + "\n"
      );
    }

    it("includes the full text of a renamed status section AND a stock Activity Log section, even though only one matches literally", async () => {
      await writeTheme(vault, "renamed-status-project", bigRenamedStatusPage());

      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue("[]") };
      await synthesizeToPending(vault, classifiedFor("renamed-status-project"), provider, "test-model", { "renamed-status-project": "project" });

      const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // "Activity Log" matches the literal heading for the project page type,
      // but "Status Overview" does not (it was renamed from "Current
      // Status" via a custom _schema.md). Both sections' full text — not
      // just the outline's 2-line preview — must still make it into the
      // prompt so the LLM can patch either one correctly.
      expect(call.prompt).toContain("status line 19");
      expect(call.prompt).toContain("activity line 19");
      expect(call.prompt).toContain(PATCH_MARKER);
    });

    it("runs the end-to-end patch flow for a source-summary page (mock LLM emitting ops)", async () => {
      await writeTheme(vault, "source-doc-2", bigSourceSummaryPage());

      const opsResponse = '```json\n[{"op":"append_to_section","heading":"Key Takeaways","content":"- New takeaway. ^[src:2026-04-20-github-activity]\\n"}]\n```';
      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue(opsResponse) };

      const onPatchOutcome = vi.fn();
      const pending = await synthesizeToPending(
        vault,
        classifiedFor("source-doc-2"),
        provider,
        "test-model",
        { "source-doc-2": "source-summary" },
        { onPatchOutcome }
      );

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(onPatchOutcome).toHaveBeenCalledWith("source-doc-2", "patch");
      expect(pending).toHaveLength(1);
      expect(pending[0].proposedContent).toContain("s".repeat(600)); // untouched section byte-identical
      expect(pending[0].proposedContent).toContain("reference line 19"); // untouched section byte-identical
      expect(pending[0].proposedContent).toContain("New takeaway.");
    });

    it("update_meta op flows through to projectStatus exactly like the whole-page <meta> block", async () => {
      await writeTheme(vault, "patch-meta", bigExistingPage());

      const opsResponse = '```json\n[{"op":"update_meta","status":"blocked","reason":"waiting on design review"}]\n```';
      const provider: LlmProvider = { complete: vi.fn().mockResolvedValue(opsResponse) };

      const pending = await synthesizeToPending(vault, classifiedFor("patch-meta"), provider, "test-model", { "patch-meta": "project" });

      expect(pending[0].projectStatus).toBe("blocked");
      expect(pending[0].projectStatusReason).toBe("waiting on design review");
      expect(pending[0].proposedContent.startsWith("<meta>")).toBe(false);
    });
  });

  describe("parseMetaBlock / stripMetaBlock", () => {
    it("extracts a well-formed status and reason", () => {
      const input = `<meta>\nstatus: active\nreason: merged feature branch\n</meta>\n\n## Body\n`;
      expect(parseMetaBlock(input)).toEqual({ status: "active", reason: "merged feature branch" });
      expect(stripMetaBlock(input)).toBe("## Body\n");
    });

    it("ignores invalid status values", () => {
      const input = `<meta>\nstatus: on-fire\n</meta>\n## x`;
      expect(parseMetaBlock(input).status).toBeUndefined();
    });

    it("returns empty object when no meta present", () => {
      expect(parseMetaBlock("## Current Status\n\nBody.")).toEqual({});
      expect(stripMetaBlock("## Current Status\n\nBody.")).toBe("## Current Status\n\nBody.");
    });

    it("truncates overly long reason strings", () => {
      const long = "a".repeat(300);
      const input = `<meta>\nstatus: paused\nreason: ${long}\n</meta>\n## x`;
      const parsed = parseMetaBlock(input);
      expect(parsed.status).toBe("paused");
      expect(parsed.reason?.length).toBeLessThanOrEqual(200);
    });
  });
});
