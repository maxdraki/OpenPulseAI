import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContentMock = vi.fn();
const getGenerativeModelMock = vi.fn().mockImplementation(() => ({
  generateContent: generateContentMock,
}));

vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: getGenerativeModelMock,
    })),
  };
});

import { GeminiProvider } from "../../src/llm/gemini.js";

describe("GeminiProvider", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it("returns response text", async () => {
    generateContentMock.mockResolvedValue({
      response: {
        text: () => "hello",
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      },
    });

    const provider = new GeminiProvider("key");
    const result = await provider.complete({ model: "gemini-x", prompt: "hi" });
    expect(result).toBe("hello");
  });

  it("accumulates token usage from usageMetadata", async () => {
    generateContentMock.mockResolvedValue({
      response: {
        text: () => "hello",
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
      },
    });

    const provider = new GeminiProvider("key");
    await provider.complete({ model: "gemini-x", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 9, outputTokens: 4 });
  });

  it("records zeros when usageMetadata is absent", async () => {
    generateContentMock.mockResolvedValue({ response: { text: () => "hello" } });

    const provider = new GeminiProvider("key");
    await provider.complete({ model: "gemini-x", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("retries a 503 GoogleGenerativeAIFetchError then succeeds", async () => {
    const fetchErr = Object.assign(new Error("overloaded"), { status: 503, name: "GoogleGenerativeAIFetchError" });
    generateContentMock
      .mockRejectedValueOnce(fetchErr)
      .mockResolvedValueOnce({
        response: { text: () => "recovered", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      });

    const provider = new GeminiProvider("key");
    const result = await provider.complete({ model: "gemini-x", prompt: "hi" });

    expect(result).toBe("recovered");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(provider.getUsageTotals().retries).toBe(1);
  }, 15000);

  it("does not retry on a 400 fetch error", async () => {
    const fetchErr = Object.assign(new Error("bad request"), { status: 400, name: "GoogleGenerativeAIFetchError" });
    generateContentMock.mockRejectedValue(fetchErr);

    const provider = new GeminiProvider("key");
    await expect(provider.complete({ model: "gemini-x", prompt: "hi" })).rejects.toThrow();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});
