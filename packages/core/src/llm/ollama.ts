import OpenAI from "openai";
import type { LlmProvider, CompletionParams } from "./provider.js";
import { withRetry } from "./retry.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";

export class OllamaProvider implements LlmProvider {
  private client: OpenAI;
  private usage = new UsageAccumulator();
  private lastTruncated: boolean | undefined;

  constructor(baseUrl: string = "http://localhost:11434") {
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "ollama", // required by SDK but unused by Ollama
    });
  }

  async complete(params: CompletionParams): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.prompt });

    const response = await withRetry(
      () =>
        this.client.chat.completions.create({
          model: params.model,
          max_tokens: params.maxTokens ?? 2048,
          temperature: params.temperature,
          messages,
        }),
      { onRetry: () => this.usage.recordRetry() }
    );

    // Ollama's OpenAI-compatible /v1 endpoint maps its native
    // prompt_eval_count/eval_count fields onto the OpenAI-shaped
    // `usage.prompt_tokens`/`usage.completion_tokens`. Fall back to the
    // native field names defensively in case a given Ollama version exposes
    // them directly on the response instead.
    const rawResponse = response as unknown as {
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };
    this.usage.recordCall({
      inputTokens: response.usage?.prompt_tokens ?? rawResponse.prompt_eval_count ?? 0,
      outputTokens: response.usage?.completion_tokens ?? rawResponse.eval_count ?? 0,
    });
    // Same dual-shape defensiveness as the usage fields above: prefer the
    // OpenAI-compatible `finish_reason`, fall back to Ollama's native
    // `done_reason` in case a given version exposes that instead.
    const finishReason = response.choices[0]?.finish_reason ?? rawResponse.done_reason;
    this.lastTruncated = finishReason == null ? undefined : finishReason === "length";

    return response.choices[0]?.message?.content ?? "";
  }

  getUsageTotals(): UsageTotals {
    return this.usage.getTotals();
  }

  resetUsage(): void {
    this.usage.reset();
  }

  wasLastCompletionTruncated(): boolean | undefined {
    return this.lastTruncated;
  }
}
