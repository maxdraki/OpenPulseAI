/** A single activity entry in a hot log file */
export interface ActivityEntry {
  timestamp: string; // ISO 8601
  log: string;
  theme?: string;
  source?: string; // which agent reported it
  id?: string; // derived: "${timestamp.slice(0,10)}-${source}" — used in ^[src:...] markers
}

/** Page type drives which synthesis template is used */
export type ThemeType = "project" | "concept" | "entity" | "source-summary";

/** LLM provider identifiers */
export type LlmProviderName = "anthropic" | "openai" | "gemini" | "mistral" | "ollama";

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
  themes: string[]; // 1-3 theme tags
  confidence: number; // 0-1
  skills?: string[]; // skill tags extracted from the entry (kebab-case); empty/absent = none detected
}

/** Lifecycle status of a project theme (absent for non-project types). */
export type ProjectStatus = "active" | "paused" | "blocked" | "complete" | "dormant";

/** Single source of truth for valid project-status values. Used for runtime validation. */
export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "active",
  "paused",
  "blocked",
  "complete",
  "dormant",
];

/** A warm theme file's parsed content */
export interface ThemeDocument {
  theme: string;
  path: string;
  content: string;
  lastUpdated: string; // ISO 8601
  type?: ThemeType;    // defaults to "project" if absent
  sources?: string[];  // entry IDs rolled up from ^[src:] markers
  related?: string[];  // related theme names
  created?: string;    // ISO 8601 — set on first synthesis
  skills?: string[];   // skill tags demonstrated by activity on this theme
  status?: ProjectStatus;     // lifecycle status (projects only)
  statusReason?: string;      // one-line justification for the status
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
  batchId?: string; // groups updates from same dream run
  type?: ThemeType;              // for new themes — drives template selection
  sources?: string[];            // rolled-up source entry IDs from ^[src:] markers
  related?: string[];            // related theme names
  created?: string;              // ISO 8601 — set on first synthesis
  skills?: string[];             // merged skill tags contributed by this update
  projectStatus?: ProjectStatus; // lifecycle status — project pages only (distinct from `status` review state above)
  projectStatusReason?: string;  // one-line justification for projectStatus
  // Sub-kind fields — at most one is set per update
  lintFix?: "stubs" | "orphans" | "merge" | "delete" | "rename" | "broken-link" | "dedup-dates";
  fixReason?: string;            // optional discriminator when multiple lintFix kinds share a value (e.g., "orphan with no substantive content")
  fixDetail?: string;            // optional human-readable detail (e.g., "aigis_v2 → aigis-v2")
  compactionType?: "scheduled" | "size";
  schemaEvolution?: {
    rationale: Array<{ change: string; evidence: string }>;
    confidence: "high" | "medium" | "low";
  };
  querybackSource?: {
    question: string;
    themesConsulted: string[];
  };
}

/** Collector runtime state per source */
export interface CollectorState {
  skillName: string;        // was: sourceName
  lastRunAt: string | null; // ISO 8601
  lastStatus: "success" | "error" | "never";
  lastError?: string;
  entriesCollected: number;
}

/** Skill config field declared in SKILL.md frontmatter */
export interface SkillConfigField {
  key: string;
  label: string;
  default?: string;
  type?: "text" | "path" | "paths" | "domain";
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
  config?: SkillConfigField[];
  setupGuide?: string;     // markdown shown in setup dialog
}

/** Multi-turn chat session */
export interface ChatSession {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  themesConsulted: string[];
  createdAt: string;      // ISO 8601
  lastActivity: string;   // ISO 8601
  pendingFile?: {
    name: string;
    content: string;
    question: string;
    themesConsulted: string[];
  };
}
