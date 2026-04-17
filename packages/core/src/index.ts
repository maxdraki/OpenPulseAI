export type {
  ActivityEntry,
  OpenPulseConfig,
  LlmProviderName,
  ClassificationResult,
  SkillConfigField,
  ThemeDocument,
  ThemeType,
  PendingUpdate,
  CollectorState,
  SkillDefinition,
  ChatSession,
} from "./types.js";
export { Vault } from "./vault.js";
export { appendActivity, saveIngestedDocument } from "./hot.js";
export { readTheme, writeTheme, listThemes, readAllThemes } from "./warm.js";
export { archiveHotFile } from "./cold.js";
export { loadConfig, DEFAULT_CONFIG } from "./config.js";
export type { LlmProvider, CompletionParams } from "./llm/provider.js";
export { createProvider } from "./llm/factory.js";
export { OllamaProvider } from "./llm/ollama.js";
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
  scheduleToCron,
  getLocalDate,
} from "./orchestrator.js";
export { parseFrontmatter, loadSkillFromFile, loadSkillsFromDir, discoverSkills } from "./skills/loader.js";
export { extractShellCommands, runSkill } from "./skills/runner.js";
export { isDue, loadCollectorState, saveCollectorState } from "./skills/scheduler.js";
export { checkEligibility, type EligibilityResult } from "./skills/eligibility.js";
export { runSkillByName, runDueSkills } from "./skills/run.js";
export { scanSkillForThreats, type ThreatFinding, type ThreatReport } from "./skills/security.js";
export { mergeThemes } from "./merge-themes.js";
