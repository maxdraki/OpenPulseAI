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
  /**
   * Optional: whether the most recent `complete()` call's response was cut
   * off by the model's output-token limit (Anthropic `stop_reason ===
   * "max_tokens"`, OpenAI/Ollama `finish_reason === "length"`, Gemini
   * `finishReason === "MAX_TOKENS"`). Returns `undefined` when the provider
   * doesn't report a stop/finish reason (or `complete()` hasn't been called
   * yet) — callers must treat `undefined` as "unknown", never assume
   * not-truncated.
   */
  wasLastCompletionTruncated?(): boolean | undefined;
}

export type { UsageTotals } from "./usage.js";

export interface CompletionParams {
  model: string;
  prompt: string;
  maxTokens?: number;
  systemPrompt?: string;
  temperature?: number; // 0 = deterministic, 1 = creative. Default varies by use case.
}
