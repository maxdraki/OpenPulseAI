import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: createMock } },
    })),
  };
});

import { OpenAIProvider } from "../../src/llm/openai.js";

describe("OpenAIProvider", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns the message content", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    const provider = new OpenAIProvider("sk-test");
    const result = await provider.complete({ model: "gpt-x", prompt: "hi" });
    expect(result).toBe("hello");
  });

  it("accumulates token usage across calls", async () => {
    createMock
      .mockResolvedValueOnce({
        choices: [{ message: { content: "a" } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "b" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });

    const provider = new OpenAIProvider("sk-test");
    await provider.complete({ model: "gpt-x", prompt: "hi" });
    await provider.complete({ model: "gpt-x", prompt: "hi again" });

    expect(provider.getUsageTotals()).toEqual({ calls: 2, retries: 0, inputTokens: 16, outputTokens: 8 });
  });

  it("records zeros when usage is unavailable", async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: "a" } }] });

    const provider = new OpenAIProvider("sk-test");
    await provider.complete({ model: "gpt-x", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("retries a transient 429 then succeeds", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    createMock
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        choices: [{ message: { content: "recovered" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

    const provider = new OpenAIProvider("sk-test");
    const result = await provider.complete({ model: "gpt-x", prompt: "hi" });

    expect(result).toBe("recovered");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(provider.getUsageTotals().retries).toBe(1);
  }, 15000);

  it("does not retry on 403", async () => {
    const forbiddenErr = Object.assign(new Error("forbidden"), { status: 403 });
    createMock.mockRejectedValue(forbiddenErr);

    const provider = new OpenAIProvider("sk-test");
    await expect(provider.complete({ model: "gpt-x", prompt: "hi" })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
