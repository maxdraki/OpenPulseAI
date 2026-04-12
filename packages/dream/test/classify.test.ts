import { describe, it, expect, vi } from "vitest";
import { classifyEntries } from "../src/classify.js";
import type { ActivityEntry, LlmProvider } from "@openpulse/core";

function mockProvider(responseText: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("classifyEntries", () => {
  it("classifies entries using LLM provider", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Refactored login page", theme: "project-auth" },
      { timestamp: "2026-04-03T11:00:00Z", log: "Posted job listing for senior dev" },
      { timestamp: "2026-04-03T12:00:00Z", log: "Fixed JWT token refresh bug" },
    ];
    const themes = ["project-auth", "hiring"];

    const provider = mockProvider(
      JSON.stringify([
        { index: 0, themes: ["hiring"] },
        { index: 1, themes: ["project-auth"] },
      ])
    );

    const results = await classifyEntries(entries, themes, provider, "test-model");

    expect(results).toHaveLength(3);
    expect(results[0].themes).toEqual(["project-auth"]);
    expect(results[0].confidence).toBe(1.0);
    expect(results[1].themes).toEqual(["hiring"]);
    expect(results[2].themes).toEqual(["project-auth"]);
  });

  it("skips LLM when all entries are pre-tagged", async () => {
    const entries: ActivityEntry[] = [
      { timestamp: "2026-04-03T10:00:00Z", log: "Updated docs", theme: "docs" },
    ];
    const provider = mockProvider("");

    const results = await classifyEntries(entries, ["docs"], provider, "test-model");

    expect(results[0].themes).toEqual(["docs"]);
    expect(results[0].confidence).toBe(1.0);
    expect(provider.complete).not.toHaveBeenCalled();
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

      const results = await classifyEntries(entries, ["openpulse"], provider, "test-model");

      // Entry should survive (has real work lines)
      expect(results).toHaveLength(1);
      expect(results[0].entry.log).not.toContain("No recent activity in docs folder");
      expect(results[0].entry.log).toContain("Committed 3 new features");
      expect(results[0].entry.log).toContain("Updated README");
    });

    it("removes entries that are entirely inactive text", async () => {
      const entries: ActivityEntry[] = [
        {
          timestamp: "2026-04-03T10:00:00Z",
          log: "No recent activity\nInactive\nNo changes detected",
        },
      ];
      const provider = mockProvider("[]");

      const results = await classifyEntries(entries, [], provider, "test-model");

      // Entirely inactive entry should be filtered out
      expect(results).toHaveLength(0);
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

      const results = await classifyEntries(entries, ["my-project"], provider, "test-model");

      expect(results).toHaveLength(1);
      expect(results[0].entry.log).toContain("Pushed 2 commits to main");
      expect(results[0].entry.log).toContain("Opened PR #42");
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

      const results = await classifyEntries(entries, [], provider, "test-model");

      expect(results).toHaveLength(1);
      expect(Array.isArray(results[0].themes)).toBe(true);
      expect(results[0].themes.length).toBeGreaterThanOrEqual(1);
      expect(results[0].themes[0]).toBe("my-project");
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

      const results = await classifyEntries(entries, existingThemes, provider, "test-model");

      expect(results).toHaveLength(1);
      // Primary tag from path + secondary from "hiring" mention
      expect(results[0].themes).toContain("my-project");
      expect(results[0].themes).toContain("hiring");
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

      const results = await classifyEntries(entries, existingThemes, provider, "test-model");

      expect(results).toHaveLength(1);
      expect(results[0].themes.length).toBeLessThanOrEqual(3);
    });
  });
});
