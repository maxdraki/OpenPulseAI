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
});
