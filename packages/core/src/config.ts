import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { OpenPulseConfig, LlmProviderName, AigisConfig } from "./types.js";

const VALID_PROVIDERS: LlmProviderName[] = ["anthropic", "openai", "gemini", "mistral", "ollama"];

export const DEFAULT_AIGIS_SUBMIT_TOOL = "aigis_submit_journal";

export const DEFAULT_CONFIG: OpenPulseConfig = {
  vaultPath: "",
  themes: [],
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  },
};

/** True when the string is a well-formed https URL — the only scheme Aigis's remote MCP server is served over. */
export function isValidAigisEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

function parseAigisConfig(parsed: any): AigisConfig | undefined {
  const raw = parsed?.aigis;
  if (!raw?.endpoint) return undefined;

  const endpoint = String(raw.endpoint);
  const requestedEnabled = Boolean(raw.enabled);

  return {
    endpoint,
    authToken: raw.authToken,
    submitTool: raw.submitTool ?? DEFAULT_AIGIS_SUBMIT_TOOL,
    // A malformed/non-https endpoint can never be "enabled" — nothing here should
    // silently attempt an outbound call against a URL that failed validation.
    enabled: requestedEnabled && isValidAigisEndpoint(endpoint),
  };
}

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
      aigis: parseAigisConfig(parsed),
    };
  } catch {
    return { ...DEFAULT_CONFIG, vaultPath: rootDir };
  }
}
