import { describe, it, expect } from "vitest";
import { createProvider } from "../../src/llm/factory.js";
import { AnthropicProvider } from "../../src/llm/anthropic.js";
import { OpenAIProvider } from "../../src/llm/openai.js";
import { GeminiProvider } from "../../src/llm/gemini.js";
import type { OpenPulseConfig } from "../../src/types.js";

function makeConfig(provider: string, apiKey?: string): OpenPulseConfig {
  return {
    vaultPath: "/tmp",
    themes: [],
    llm: {
      provider: provider as any,
      model: "test-model",
      apiKey,
    },
  };
}

describe("createProvider", () => {
  it("creates AnthropicProvider for anthropic config", () => {
    const provider = createProvider(makeConfig("anthropic", "sk-test"));
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("creates OpenAIProvider for openai config", () => {
    const provider = createProvider(makeConfig("openai", "sk-test"));
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("creates GeminiProvider for gemini config", () => {
    const provider = createProvider(makeConfig("gemini", "test-key"));
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it("throws for gemini without API key", () => {
    expect(() => createProvider(makeConfig("gemini"))).toThrow("requires an API key");
  });

  it("throws for unknown provider", () => {
    expect(() => createProvider(makeConfig("unknown"))).toThrow("Unknown LLM provider");
  });
});
