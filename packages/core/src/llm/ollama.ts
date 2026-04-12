import OpenAI from "openai";
import type { LlmProvider, CompletionParams } from "./provider.js";

export class OllamaProvider implements LlmProvider {
  private client: OpenAI;

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

    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      temperature: params.temperature,
      messages,
    });

    return response.choices[0]?.message?.content ?? "";
  }
}
