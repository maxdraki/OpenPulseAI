import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, CompletionParams } from "./provider.js";
import { withRetry } from "./retry.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  private usage = new UsageAccumulator();

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async complete(params: CompletionParams): Promise<string> {
    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: params.model,
          max_tokens: params.maxTokens ?? 2048,
          temperature: params.temperature,
          system: params.systemPrompt,
          messages: [{ role: "user", content: params.prompt }],
        }),
      { onRetry: () => this.usage.recordRetry() }
    );

    this.usage.recordCall({
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  getUsageTotals(): UsageTotals {
    return this.usage.getTotals();
  }

  resetUsage(): void {
    this.usage.reset();
  }
}
