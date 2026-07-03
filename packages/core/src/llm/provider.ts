import type { UsageTotals } from "./usage.js";

/**
 * Provider-agnostic LLM interface.
 * All providers must implement this contract.
 */
export interface LlmProvider {
  /** Send a prompt and get a text response */
  complete(params: CompletionParams): Promise<string>;
  /**
   * Optional: cumulative token/call/retry totals since the last `resetUsage()`
   * (or since construction). Providers that can't report usage should still
   * implement this and record zeros — callers should never estimate silently.
   */
  getUsageTotals?(): UsageTotals;
  /** Optional: zero out this provider's usage accumulator. */
  resetUsage?(): void;
}

export type { UsageTotals } from "./usage.js";

export interface CompletionParams {
  model: string;
  prompt: string;
  maxTokens?: number;
  systemPrompt?: string;
  temperature?: number; // 0 = deterministic, 1 = creative. Default varies by use case.
}
