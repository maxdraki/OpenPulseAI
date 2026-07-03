export type {
  ActivityEntry,
  OpenPulseConfig,
  LlmProviderName,
  ClassificationResult,
  SkillConfigField,
  ThemeDocument,
  ThemeType,
  ProjectStatus,
  PendingUpdate,
  CollectorState,
  SkillDefinition,
  ChatSession,
} from "./types.js";
export { PROJECT_STATUSES } from "./types.js";
export { Vault } from "./vault.js";
export {
  appendActivity,
  saveIngestedDocument,
  parseActivityBlock,
  parseActivityBlocks,
  splitHotFileBlocks,
  joinHotFileBlocks,
  ENTRY_MARKER,
  type ParsedActivityBlock,
} from "./hot.js";
export { readTheme, writeTheme, listThemes, readAllThemes } from "./warm.js";
export { archiveHotFile } from "./cold.js";
export { loadConfig, DEFAULT_CONFIG } from "./config.js";
export type { LlmProvider, CompletionParams, UsageTotals } from "./llm/provider.js";
export { createProvider } from "./llm/factory.js";
export { OllamaProvider } from "./llm/ollama.js";
export { stripCodeFences } from "./llm/strip-fences.js";
export { withRetry, classifyError, LlmError } from "./llm/retry.js";
export type { RetryOptions, LlmErrorOptions } from "./llm/retry.js";
export { UsageAccumulator, emptyUsageTotals, mergeUsageTotals } from "./llm/usage.js";
export type { TokenUsage } from "./llm/usage.js";
export { initLogger, vaultLog } from "./logger.js";
export type { LogLevel, LogEntry } from "./logger.js";
export {
  Orchestrator,
  type Schedule,
  type CollectorState as OrchestratorCollectorState,
  type DreamPipelineState,
  type LintPipelineState,
  type OrchestratorState,
  type OrchestratorCallbacks,
  defaultState,
  loadState,
  saveState,
  updateStateSection,
  scheduleToCron,
  getLocalDate,
} from "./orchestrator.js";
export { parseFrontmatter, loadSkillFromFile, loadSkillsFromDir, discoverSkills } from "./skills/loader.js";
export { extractShellCommands, runSkill } from "./skills/runner.js";
export { isDue, loadCollectorState, saveCollectorState } from "./skills/scheduler.js";
export { checkEligibility, type EligibilityResult } from "./skills/eligibility.js";
export { runSkillByName, runDueSkills } from "./skills/run.js";
export { scanSkillForThreats, type ThreatFinding, type ThreatReport } from "./skills/security.js";
export { mergeThemes, isSafeThemeName } from "./merge-themes.js";
export { sanitizeThemeSlug } from "./theme-slug.js";
export { SEED_SKILLS, isKnownSkill, isValidSkillTag, normaliseSkill } from "./skills-taxonomy.js";
export { checkStaleness, normalizeContentForCompare, type StalenessResult } from "./staleness.js";
export { ensureVaultRepo, commitVault } from "./vault-git.js";
export {
  searchIndex,
  searchWithRebuildRetry,
  fuseRankings,
  sanitizeFtsQuery,
  RRF_K,
  type SearchResult,
  type SearchSignal,
} from "./search/search.js";
export { rebuildIndex, updateThemeInIndex, removeThemeFromIndex } from "./search/index-db.js";
