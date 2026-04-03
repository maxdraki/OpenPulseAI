import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, CompletionParams } from "./provider.js";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async complete(params: CompletionParams): Promise<string> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.prompt }],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }
}
