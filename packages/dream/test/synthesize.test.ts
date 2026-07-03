import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { ClassificationResult, LlmProvider } from "@openpulse/core";
import { synthesizeToPending, parseMetaBlock, stripMetaBlock } from "../src/synthesize.js";

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
