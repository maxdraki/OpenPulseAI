import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LlmProvider, CompletionParams } from "./provider.js";
import { withRetry } from "./retry.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";

export class GeminiProvider implements LlmProvider {
  private genAI: GoogleGenerativeAI;
  private usage = new UsageAccumulator();
  private lastTruncated: boolean | undefined;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async complete(params: CompletionParams): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: params.model,
      systemInstruction: params.systemPrompt,
      generationConfig: params.temperature !== undefined ? { temperature: params.temperature } : undefined,
    });

    const result = await withRetry(() => model.generateContent(params.prompt), {
      onRetry: () => this.usage.recordRetry(),
    });

    this.usage.recordCall({
      inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    });
    const finishReason = result.response.candidates?.[0]?.finishReason;
    this.lastTruncated = finishReason == null ? undefined : finishReason === "MAX_TOKENS";

    return result.response.text();
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
