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
