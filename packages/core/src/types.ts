/** A single activity entry in a hot log file */
export interface ActivityEntry {
  timestamp: string; // ISO 8601
  log: string;
  theme?: string;
  source?: string; // which agent reported it
}

/** LLM provider identifiers */
export type LlmProviderName = "anthropic" | "openai" | "gemini";

/** Configuration for OpenPulseAI */
export interface OpenPulseConfig {
  vaultPath: string;
  themes: string[]; // known theme names
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string; // resolved from env or keychain if not set
  };
}

/** Result of classifying a hot entry into a theme */
export interface ClassificationResult {
  entry: ActivityEntry;
  theme: string; // matched or new theme name
  confidence: number; // 0-1
}

/** A warm theme file's parsed content */
export interface ThemeDocument {
  theme: string;
  path: string;
  content: string;
  lastUpdated: string; // ISO 8601
}

/** A pending warm update awaiting user approval */
export interface PendingUpdate {
  id: string; // unique ID for this proposal
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: ActivityEntry[]; // source entries that led to this update
  createdAt: string; // ISO 8601
  status: "pending" | "approved" | "rejected" | "edited";
}
