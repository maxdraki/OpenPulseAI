import type { LlmProvider } from "./provider.js";
import type { OpenPulseConfig } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";

export function createProvider(config: OpenPulseConfig): LlmProvider {
  const apiKey = config.llm.apiKey ?? getEnvKey(config.llm.provider);

  switch (config.llm.provider) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAIProvider(apiKey, config.llm.baseUrl);
    case "gemini":
      if (!apiKey) throw new Error("Gemini requires an API key (set GEMINI_API_KEY or configure in settings)");
      return new GeminiProvider(apiKey);
    case "mistral":
      if (!apiKey) throw new Error("Mistral requires an API key (set MISTRAL_API_KEY or configure in settings)");
      return new OpenAIProvider(apiKey, "https://api.mistral.ai/v1");
    case "ollama":
      return new OllamaProvider(config.llm.baseUrl);
    default:
      throw new Error(`Unknown LLM provider: ${config.llm.provider}`);
  }
}

function getEnvKey(provider: string): string | undefined {
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
    mistral: "MISTRAL_API_KEY",
  };
  return process.env[envMap[provider] ?? ""];
}
