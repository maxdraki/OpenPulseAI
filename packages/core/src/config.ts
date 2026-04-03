import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { OpenPulseConfig, LlmProviderName, SourceConfig } from "./types.js";

const VALID_PROVIDERS: LlmProviderName[] = ["anthropic", "openai", "gemini"];

export const DEFAULT_CONFIG: OpenPulseConfig = {
  vaultPath: "",
  themes: [],
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  },
  sources: [],
};

export async function loadConfig(rootDir: string): Promise<OpenPulseConfig> {
  const configPath = join(rootDir, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parse(raw);
    const provider = VALID_PROVIDERS.includes(parsed?.llm?.provider)
      ? parsed.llm.provider
      : "anthropic";

    const sources: SourceConfig[] = (parsed?.sources ?? [])
      .filter((s: any) => s?.name && s?.command)
      .map((s: any) => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        schedule: s.schedule ?? "0 23 * * *",
        lookback: s.lookback ?? "24h",
        template: s.template ?? undefined,
        enabled: s.enabled ?? true,
        env: s.env ?? {},
      }));

    return {
      vaultPath: rootDir,
      themes: parsed?.themes ?? [],
      llm: {
        provider,
        model: parsed?.llm?.model ?? DEFAULT_CONFIG.llm.model,
        apiKey: parsed?.llm?.apiKey,
      },
      sources,
    };
  } catch {
    return { ...DEFAULT_CONFIG, vaultPath: rootDir };
  }
}
