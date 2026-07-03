import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: createMock } },
    })),
  };
});

import { OllamaProvider } from "../../src/llm/ollama.js";

describe("OllamaProvider", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("instantiates with default base URL", () => {
    const provider = new OllamaProvider();
    expect(provider).toBeDefined();
  });

  it("instantiates with custom base URL", () => {
    const provider = new OllamaProvider("http://192.168.1.100:11434");
    expect(provider).toBeDefined();
  });

  it("implements complete() method", () => {
    const provider = new OllamaProvider();
    expect(typeof provider.complete).toBe("function");
  });

  it("accumulates token usage from OpenAI-shaped usage field", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const provider = new OllamaProvider();
    const result = await provider.complete({ model: "llama3", prompt: "hi" });

    expect(result).toBe("hello");
    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 7, outputTokens: 3 });
  });

  it("falls back to native prompt_eval_count/eval_count when usage is absent", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "hello" } }],
      prompt_eval_count: 11,
      eval_count: 4,
    });

    const provider = new OllamaProvider();
    await provider.complete({ model: "llama3", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 11, outputTokens: 4 });
  });

  it("records zeros when no usage information is present at all", async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: "hello" } }] });

    const provider = new OllamaProvider();
    await provider.complete({ model: "llama3", prompt: "hi" });

    expect(provider.getUsageTotals()).toEqual({ calls: 1, retries: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("retries on ECONNRESET then succeeds", async () => {
    const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    createMock
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const provider = new OllamaProvider();
    const result = await provider.complete({ model: "llama3", prompt: "hi" });

    expect(result).toBe("recovered");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(provider.getUsageTotals().retries).toBe(1);
  }, 15000);
});
