import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { OpenPulseConfig, LlmProviderName } from "./types.js";

const VALID_PROVIDERS: LlmProviderName[] = ["anthropic", "openai", "gemini", "mistral", "ollama"];

export const DEFAULT_CONFIG: OpenPulseConfig = {
  vaultPath: "",
  themes: [],
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  },
};

export async function loadConfig(rootDir: string): Promise<OpenPulseConfig> {
  const configPath = join(rootDir, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parse(raw);
    const provider = VALID_PROVIDERS.includes(parsed?.llm?.provider)
      ? parsed.llm.provider
      : "anthropic";

    return {
      vaultPath: rootDir,
      themes: parsed?.themes ?? [],
      llm: {
        provider,
        model: parsed?.llm?.model ?? DEFAULT_CONFIG.llm.model,
        apiKey: parsed?.llm?.apiKey,
        baseUrl: parsed?.llm?.baseUrl,
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, vaultPath: rootDir };
  }
}
