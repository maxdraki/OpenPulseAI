/** A single activity entry in a hot log file */
export interface ActivityEntry {
  timestamp: string; // ISO 8601
  log: string;
  theme?: string;
  source?: string; // which agent reported it
}

/** LLM provider identifiers */
export type LlmProviderName = "anthropic" | "openai" | "gemini" | "ollama";

/** Configuration for OpenPulseAI */
export interface OpenPulseConfig {
  vaultPath: string;
  themes: string[]; // known theme names
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string; // resolved from env or keychain if not set
    baseUrl?: string; // Ollama base URL (default http://localhost:11434)
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

/** Collector runtime state per source */
export interface CollectorState {
  skillName: string;        // was: sourceName
  lastRunAt: string | null; // ISO 8601
  lastStatus: "success" | "error" | "never";
  lastError?: string;
  entriesCollected: number;
}

/** Parsed skill from a SKILL.md file */
export interface SkillDefinition {
  name: string;
  description: string;
  location: string;        // absolute path to SKILL.md
  body: string;            // markdown content after frontmatter
  schedule?: string;       // cron expression (OpenPulse extension)
  lookback: string;        // default "24h" (OpenPulse extension)
  requires: {
    bins: string[];
    env: string[];
  };
}

/** Multi-turn chat session */
export interface ChatSession {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  themesConsulted: string[];
  createdAt: string;      // ISO 8601
  lastActivity: string;   // ISO 8601
}
