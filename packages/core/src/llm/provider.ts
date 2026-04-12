/**
 * Provider-agnostic LLM interface.
 * All providers must implement this contract.
 */
export interface LlmProvider {
  /** Send a prompt and get a text response */
  complete(params: CompletionParams): Promise<string>;
}

export interface CompletionParams {
  model: string;
  prompt: string;
  maxTokens?: number;
  systemPrompt?: string;
  temperature?: number; // 0 = deterministic, 1 = creative. Default varies by use case.
}
