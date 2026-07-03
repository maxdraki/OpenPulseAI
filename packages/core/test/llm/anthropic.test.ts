import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: createMock },
    })),
  };
});

import { AnthropicProvider } from "../../src/llm/anthropic.js";

describe("AnthropicProvider", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns the text block from the response", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider("sk-test");
    const result = await provider.complete({ model: "claude-x", prompt: "hi" });
    expect(result).toBe("hello");
  });

  it("accumulates token usage across calls", async () => {
    createMock
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "a" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "b" }],
        usage: { input_tokens: 20, output_tokens: 8 },
      });

    const provider = new AnthropicProvider("sk-test");
    await provider.complete({ model: "claude-x", prompt: "hi" });
    await provider.complete({ model: "claude-x", prompt: "hi again" });

    expect(provider.getUsageTotals()).toEqual({
      calls: 2,
      retries: 0,
      inputTokens: 30,
      outputTokens: 13,
    });
  });

  it("records zeros when usage is unavailable", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "a" }] });

    const provider = new AnthropicProvider("sk-test");
    await provider.complete({ model: "claude-x", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({
      calls: 1,
      retries: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("resetUsage zeroes the accumulator", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "a" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider("sk-test");
    await provider.complete({ model: "claude-x", prompt: "hi" });
    provider.resetUsage();

    expect(provider.getUsageTotals()).toEqual({ calls: 0, retries: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("retries a transient 503 then succeeds, recording the retry", async () => {
    const rateLimitErr = Object.assign(new Error("overloaded"), { status: 503 });
    createMock
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "recovered" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    const provider = new AnthropicProvider("sk-test");
    const result = await provider.complete({ model: "claude-x", prompt: "hi" });

    expect(result).toBe("recovered");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(provider.getUsageTotals().retries).toBe(1);
  }, 15000);

  it("does not retry on 401 and propagates the error", async () => {
    const authErr = Object.assign(new Error("bad key"), { status: 401 });
    createMock.mockRejectedValue(authErr);

    const provider = new AnthropicProvider("sk-test");
    await expect(provider.complete({ model: "claude-x", prompt: "hi" })).rejects.toThrow();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  describe("wasLastCompletionTruncated", () => {
    it("reports true when stop_reason is max_tokens", async () => {
      createMock.mockResolvedValue({
        content: [{ type: "text", text: "cut off" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "max_tokens",
      });

      const provider = new AnthropicProvider("sk-test");
      await provider.complete({ model: "claude-x", prompt: "hi" });
      expect(provider.wasLastCompletionTruncated?.()).toBe(true);
    });

    it("reports false when stop_reason is end_turn", async () => {
      createMock.mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      });

      const provider = new AnthropicProvider("sk-test");
      await provider.complete({ model: "claude-x", prompt: "hi" });
      expect(provider.wasLastCompletionTruncated?.()).toBe(false);
    });

    it("reports undefined when stop_reason is absent", async () => {
      createMock.mockResolvedValue({
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const provider = new AnthropicProvider("sk-test");
      await provider.complete({ model: "claude-x", prompt: "hi" });
      expect(provider.wasLastCompletionTruncated?.()).toBeUndefined();
    });
  });
});
