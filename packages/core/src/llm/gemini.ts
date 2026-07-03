import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LlmProvider, CompletionParams } from "./provider.js";
import { withRetry } from "./retry.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";

export class GeminiProvider implements LlmProvider {
  private genAI: GoogleGenerativeAI;
  private usage = new UsageAccumulator();

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

    return result.response.text();
  }

  getUsageTotals(): UsageTotals {
    return this.usage.getTotals();
  }

  resetUsage(): void {
    this.usage.reset();
  }
}
