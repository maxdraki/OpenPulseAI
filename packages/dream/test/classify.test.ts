import { describe, it, expect, vi } from "vitest";
import { classifyEntries } from "../src/classify.js";
import type { ActivityEntry, LlmProvider } from "@openpulse/core";

function mockProvider(responseText: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("classifyEntries", () => {
  it("classifies entries using LLM provider", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Refactored login page; updated auth middleware", theme: "project-auth" },
      { timestamp: "2026-04-03T11:00:00Z", log: "Posted job listing for senior dev; updated hiring board" },
      { timestamp: "2026-04-03T12:00:00Z", log: "Fixed JWT token refresh bug; committed to auth repo" },
    ];
    const themes = ["project-auth", "hiring"];

    const provider = mockProvider(
      JSON.stringify([
        { index: 0, themes: ["hiring"], type: "project" },
        { index: 1, themes: ["project-auth"], type: "project" },
      ])
    );

    const { classified } = await classifyEntries(entries, themes, provider, "test-model");

    expect(classified).toHaveLength(3);
    expect(classified[0].themes).toEqual(["project-auth"]);
    expect(classified[0].confidence).toBe(1.0);
    expect(classified[1].themes).toEqual(["hiring"]);
    expect(classified[2].themes).toEqual(["project-auth"]);
  });

  it("skips LLM when all entries are pre-tagged", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Updated docs", theme: "docs" },
    ];
    const provider = mockProvider("");

    const { classified } = await classifyEntries(entries, ["docs"], provider, "test-model");

    expect(classified[0].themes).toEqual(["docs"]);
    expect(classified[0].confidence).toBe(1.0);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("returns proposedTypes for new themes", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Posted job listing for senior dev; updated hiring board and anchored the work in existing-anchor" },
    ];
    const provider = mockProvider(
      JSON.stringify([{ index: 0, themes: ["existing-anchor", "hiring"], type: "concept" }])
    );

    // Pass an existing theme so the LLM-proposed entry stays in classified
    // (the orphan router sends entries with entirely-new themes to orphanCandidates instead)
    const { classified, proposedTypes } = await classifyEntries(entries, ["existing-anchor"], provider, "test-model");

    expect(classified).toHaveLength(1);
    expect(proposedTypes["hiring"]).toBe("concept");
  });

  it("does not include existing themes in proposedTypes", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Posted job listing for senior dev" },
    ];
    const provider = mockProvider(
      JSON.stringify([{ index: 0, themes: ["hiring"], type: "project" }])
    );

    const { proposedTypes } = await classifyEntries(entries, ["hiring"], provider, "test-model");

    expect(proposedTypes["hiring"]).toBeUndefined();
  });

  it("accumulates concept candidates from LLM response", async () => {
    const provider = {
      complete: async () => JSON.stringify([{ index: 0, themes: ["myproject"], type: "project", concept_candidates: ["barrier-pattern", "wiki-maturity"] }]),
    } as any;
    const entry: ActivityEntry = {
      timestamp: "2026-04-17T00:00:00Z",
      log: "Some activity about committed changes to myproject. Line two here. Line three here. Line four here. Line five here.",
      source: "github-activity",
    };
    const result = await classifyEntries([entry], [], provider, "gpt");
    expect(result.conceptCandidates["barrier-pattern"]).toBeDefined();
    expect(result.conceptCandidates["barrier-pattern"].count).toBe(1);
    expect(result.conceptCandidates["barrier-pattern"].sources).toContain("github-activity");
    expect(result.conceptCandidates["wiki-maturity"]).toBeDefined();
  });

  describe("preFilter", () => {
    it("strips lines with 'no activity' / 'inactive' / 'no changes' but keeps lines with actual work", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "## OpenPulseAI\nCommitted 3 new features\nNo recent activity in docs folder\nUpdated README",
          theme: "openpulse",
        },
      ];
      const provider = mockProvider("");

      const { classified } = await classifyEntries(entries, ["openpulse"], provider, "test-model");

      // Entry should survive (has real work lines)
      expect(classified).toHaveLength(1);
      expect(classified[0].entry.log).not.toContain("No recent activity in docs folder");
      expect(classified[0].entry.log).toContain("Committed 3 new features");
      expect(classified[0].entry.log).toContain("Updated README");
    });

    it("removes entries that are entirely inactive text", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "No recent activity\nInactive\nNo changes detected",
        },
      ];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, [], provider, "test-model");

      // Entirely inactive entry should be filtered out
      expect(classified).toHaveLength(0);
    });

    it("passes through clean GitHub activity content", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "Repository: owner/my-project\nPushed 2 commits to main\nOpened PR #42: Add wiki pipeline",
          theme: "my-project",
        },
      ];
      const provider = mockProvider("");

      const { classified } = await classifyEntries(entries, ["my-project"], provider, "test-model");

      expect(classified).toHaveLength(1);
      expect(classified[0].entry.log).toContain("Pushed 2 commits to main");
      expect(classified[0].entry.log).toContain("Opened PR #42");
    });

    it("removes entries with only orphaned headings and no content", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "## Section A\n## Section B\n## Section C",
        },
      ];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, [], provider, "test-model");

      expect(classified).toHaveLength(0);
    });
  });

  describe("deterministic classifier", () => {
    it("returns themes[] array (not single string) for file path entries", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "Modified /Users/dev/Documents/GitHub/my-project/src/index.ts — added exports",
        },
      ];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, [], provider, "test-model");

      expect(classified).toHaveLength(1);
      expect(Array.isArray(classified[0].themes)).toBe(true);
      expect(classified[0].themes.length).toBeGreaterThanOrEqual(1);
      expect(classified[0].themes[0]).toBe("my-project");
    });

    it("finds secondary themes from existing theme names mentioned in text", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "Modified /Users/dev/Documents/GitHub/my-project/src/index.ts — also updated hiring docs",
        },
      ];
      const existingThemes = ["hiring", "docs", "frontend"];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, existingThemes, provider, "test-model");

      expect(classified).toHaveLength(1);
      // Primary tag from path + secondary from "hiring" mention
      expect(classified[0].themes).toContain("my-project");
      expect(classified[0].themes).toContain("hiring");
    });

    it("caps multi-tag at 3 themes per entry", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          // Path gives primary tag; text mentions 4 existing themes
          log: "Modified /Users/dev/Documents/GitHub/my-project/src/index.ts — touches frontend, hiring, docs, and devops",
        },
      ];
      const existingThemes = ["frontend", "hiring", "docs", "devops"];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, existingThemes, provider, "test-model");

      expect(classified).toHaveLength(1);
      expect(classified[0].themes.length).toBeLessThanOrEqual(3);
    });

    it("classifies ### owner/repo heading format", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "### myorg/my-service\nPushed 3 commits to main branch",
        },
      ];
      const provider = mockProvider("[]");

      const { classified } = await classifyEntries(entries, [], provider, "test-model");

      expect(classified).toHaveLength(1);
      expect(classified[0].themes).toContain("my-service");
    });
  });

  describe("classifyEntries — entry-level preFilter drop", () => {
    it("drops entries that have fewer than 5 substantive lines and no activity tokens", async () => {
      const entry: ActivityEntry = {
        timestamp: "2026-04-17T00:00:00Z",
        log: "## Status\n- **Repo:** foo\n- inactive\n",
        source: "github-activity",
      };
      const provider = mockProvider("[]");
      const result = await classifyEntries([entry], [], provider, "gpt");
      expect(result.classified).toHaveLength(0);
    });

    it("keeps entries with commit/PR/merge tokens even if short", async () => {
      const entry: ActivityEntry = {
        timestamp: "2026-04-17T00:00:00Z",
        log: "Merged PR #47\nCommit abc123",
        source: "github-activity",
      };
      const provider = mockProvider("[]");
      const result = await classifyEntries([entry], [], provider, "gpt");
      // Short entries with activity tokens survive preFilter; may still be filtered later, but not dropped here
      // This test just verifies preFilter itself does not drop them
      // Since mockProvider returns [], classifyEntries might route them to uncategorized — we just check they weren't silently zeroed by preFilter
      // We assert either classified has them OR the mock LLM path returned a record for them
      const totalRoutedEntries = result.classified.length;
      expect(totalRoutedEntries).toBeGreaterThan(0);
    });

    it("keeps entries with enough substantive lines even without activity tokens", async () => {
      const entry: ActivityEntry = {
        timestamp: "2026-04-17T00:00:00Z",
        log: "Line one has content.\nLine two has content.\nLine three has content.\nLine four has content.\nLine five has content.",
        source: "folder-watcher",
      };
      const provider = mockProvider("[]");
      const result = await classifyEntries([entry], [], provider, "gpt");
      expect(result.classified.length).toBeGreaterThan(0);
    });
  });
});

describe("classifyEntries — orphan candidates", () => {
  it("routes LLM-only entries with entirely-new themes to orphanCandidates (confidence < 0.5)", async () => {
    const provider = {
      complete: async () => JSON.stringify([{ index: 0, themes: ["brand-new-theme"], type: "project" }]),
    } as any;
    const entry = {
      timestamp: "2026-04-17T00:00:00Z",
      log: "Some meaningful activity with enough substantive lines so it survives preFilter. Line two. Line three. Line four. Line five. Committed changes.",
      source: "github-activity",
    };
    // No existing themes — so the proposed theme has no anchor
    const result = await classifyEntries([entry], [], provider, "gpt");
    expect(result.orphanCandidates.length).toBe(1);
    expect(result.orphanCandidates[0].proposedThemes).toContain("brand-new-theme");
    expect(result.classified.length).toBe(0);
  });

  it("keeps LLM entries in classified when at least one theme matches existing", async () => {
    const provider = {
      complete: async () => JSON.stringify([{ index: 0, themes: ["existing-theme", "new-theme"], type: "project" }]),
    } as any;
    const entry = {
      timestamp: "2026-04-17T00:00:00Z",
      log: "Some meaningful activity with enough substantive lines so it survives preFilter. Line two. Line three. Line four. Line five. Committed changes.",
      source: "github-activity",
    };
    const result = await classifyEntries([entry], ["existing-theme"], provider, "gpt");
    expect(result.orphanCandidates.length).toBe(0);
    expect(result.classified.length).toBe(1);
  });
});

describe("classifyEntries — skills extraction", () => {
  const entry = {
    timestamp: "2026-04-17T00:00:00Z",
    log: "Substantive line one. Line two. Line three. Line four. Line five. Committed changes to foo.ts.",
    source: "github-activity",
  };

  it("attaches normalised skills to the ClassificationResult", async () => {
    const provider = {
      complete: async () =>
        JSON.stringify([
          { index: 0, themes: ["existing"], type: "project", skills: ["TypeScript", "pr-review"] },
        ]),
    } as any;
    const result = await classifyEntries([entry], ["existing"], provider, "gpt");
    expect(result.classified[0].skills).toEqual(expect.arrayContaining(["typescript", "pr-review"]));
  });

  it("defaults skills to an empty array when the LLM omits the field", async () => {
    const provider = {
      complete: async () => JSON.stringify([{ index: 0, themes: ["existing"], type: "project" }]),
    } as any;
    const result = await classifyEntries([entry], ["existing"], provider, "gpt");
    expect(result.classified[0].skills).toEqual([]);
  });

  it("tolerates a non-array skills value and yields an empty skill list", async () => {
    const provider = {
      complete: async () =>
        JSON.stringify([{ index: 0, themes: ["existing"], type: "project", skills: "typescript" }]),
    } as any;
    const result = await classifyEntries([entry], ["existing"], provider, "gpt");
    expect(result.classified[0].skills).toEqual([]);
  });

  it("drops invalid skill tags and caps the list at 5", async () => {
    const provider = {
      complete: async () =>
        JSON.stringify([
          {
            index: 0,
            themes: ["existing"],
            type: "project",
            skills: ["a", "", "typescript", "pr-review", "ops", "docker", "kubernetes", "system-design"],
          },
        ]),
    } as any;
    const result = await classifyEntries([entry], ["existing"], provider, "gpt");
    expect(result.classified[0].skills!.length).toBeLessThanOrEqual(5);
    // "a" is too short to be a valid tag
    expect(result.classified[0].skills).not.toContain("a");
  });
});
