import OpenAI from "openai";
import type { LlmProvider, CompletionParams } from "./provider.js";
import { withRetry } from "./retry.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";

export class OpenAIProvider implements LlmProvider {
  private client: OpenAI;
  private usage = new UsageAccumulator();
  private lastTruncated: boolean | undefined;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
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

    this.usage.recordCall({
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    });
    const finishReason = response.choices[0]?.finish_reason;
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
