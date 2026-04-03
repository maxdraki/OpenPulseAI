import OpenAI from "openai";
import type { LlmProvider, CompletionParams } from "./provider.js";

export class OpenAIProvider implements LlmProvider {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI(apiKey ? { apiKey } : undefined);
  }

  async complete(params: CompletionParams): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.prompt });

    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      messages,
    });

    return response.choices[0]?.message?.content ?? "";
  }
}
