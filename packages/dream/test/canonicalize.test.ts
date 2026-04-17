import { describe, it, expect, vi } from "vitest";
import { normalizeThemeName, findFuzzyMatches, canonicalizeThemes } from "../src/canonicalize.js";

describe("normalizeThemeName", () => {
  it("lowercases", () => { expect(normalizeThemeName("OpenPulse")).toBe("openpulse"); });
  it("kebab-cases", () => { expect(normalizeThemeName("Open Pulse AI")).toBe("open-pulse-ai"); });
  it("collapses repeated separators", () => { expect(normalizeThemeName("a--b__c")).toBe("a-b-c"); });
  it("trims leading/trailing separators", () => { expect(normalizeThemeName("-foo-")).toBe("foo"); });
});

describe("findFuzzyMatches", () => {
  it("detects Levenshtein <= 2", () => {
    const r = findFuzzyMatches(["dream", "dreams"]);
    expect(r).toContainEqual({ a: "dream", b: "dreams", reason: "levenshtein" });
  });
  it("detects prefix >= 6", () => {
    const r = findFuzzyMatches(["openpulse", "openpulseai"]);
    expect(r).toContainEqual(expect.objectContaining({ a: "openpulse", b: "openpulseai" }));
  });
  it("does not flag unrelated names", () => {
    const r = findFuzzyMatches(["cat", "dog", "elephant"]);
    expect(r).toEqual([]);
  });
});

describe("canonicalizeThemes", () => {
  const nullProvider = { complete: vi.fn().mockResolvedValue("[]") } as any;

  it("redirects exact-after-normalization matches silently", async () => {
    const result = await canonicalizeThemes(["OpenPulse"], ["openpulse"], nullProvider, "gpt");
    expect(result.redirects).toEqual({ "OpenPulse": "openpulse" });
    expect(result.proposals).toEqual([]);
  });

  it("proposes fuzzy matches (Levenshtein)", async () => {
    const result = await canonicalizeThemes(["dreams"], ["dream"], nullProvider, "gpt");
    expect(result.redirects).toEqual({});
    expect(result.proposals).toContainEqual({ proposed: "dreams", canonical: "dream", reason: "levenshtein" });
  });

  it("proposes prefix matches", async () => {
    const result = await canonicalizeThemes(["openpulseai"], ["openpulse"], nullProvider, "gpt");
    expect(result.proposals).toContainEqual(expect.objectContaining({ proposed: "openpulseai", canonical: "openpulse" }));
  });

  it("calls LLM only when new themes survive deterministic passes", async () => {
    const spy = vi.fn().mockResolvedValue("[]");
    await canonicalizeThemes(["foo"], ["foo"], { complete: spy } as any, "gpt");
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls LLM for truly-new themes and converts non-null canonicals into proposals", async () => {
    const llmResponse = JSON.stringify([{ proposed: "auth-system", canonical: "authentication" }]);
    const provider = { complete: vi.fn().mockResolvedValue(llmResponse) } as any;
    const result = await canonicalizeThemes(["auth-system"], ["authentication"], provider, "gpt");
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(result.proposals).toContainEqual({ proposed: "auth-system", canonical: "authentication", reason: "llm" });
  });

  it("drops null-canonical LLM responses", async () => {
    const llmResponse = JSON.stringify([{ proposed: "new-thing", canonical: null }]);
    const provider = { complete: vi.fn().mockResolvedValue(llmResponse) } as any;
    const result = await canonicalizeThemes(["new-thing"], ["unrelated"], provider, "gpt");
    expect(result.proposals).toEqual([]);
  });
});
