import { describe, it, expect } from "vitest";
import { estimateTokensUsed, lookupContextWindow } from "../server.js";

describe("estimateTokensUsed", () => {
  it("returns just the system overhead for an empty session", () => {
    expect(estimateTokensUsed([])).toBe(1000);
    expect(estimateTokensUsed([], 500)).toBe(500);
  });

  it("uses ~chars/4 for content", () => {
    // 4 chars → 1 token + overhead
    expect(estimateTokensUsed([{ content: "abcd" }], 0)).toBe(1);
    // 8 chars → 2 tokens
    expect(estimateTokensUsed([{ content: "abcdefgh" }], 0)).toBe(2);
  });

  it("rounds up partial tokens", () => {
    // 5 chars → 1.25 → 2
    expect(estimateTokensUsed([{ content: "abcde" }], 0)).toBe(2);
  });

  it("sums multiple messages", () => {
    expect(estimateTokensUsed(
      [{ content: "abcd" }, { content: "efgh" }, { content: "ijkl" }],
      0,
    )).toBe(3);
  });

  it("tolerates messages with no content", () => {
    expect(estimateTokensUsed([{ content: "" }], 0)).toBe(0);
    expect(estimateTokensUsed([{ content: "" } as unknown as { content: string }], 0)).toBe(0);
  });

  it("handles a realistic session at the right order of magnitude", () => {
    // Approx 4000 chars across 4 turns ≈ 1000 tokens + 1000 overhead = 2000
    const messages = Array.from({ length: 4 }, () => ({ content: "x".repeat(1000) }));
    expect(estimateTokensUsed(messages)).toBe(2000);
  });
});

describe("lookupContextWindow", () => {
  it("returns the known size for hosted models", () => {
    expect(lookupContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(lookupContextWindow("gpt-4o")).toBe(128_000);
    expect(lookupContextWindow("gemini-2.5-flash")).toBe(1_000_000);
  });

  it("falls back to a conservative default for unknown models", () => {
    expect(lookupContextWindow("ollama:llama3.1:8b")).toBe(32_000);
    expect(lookupContextWindow("")).toBe(32_000);
  });
});
