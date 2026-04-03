import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LlmProvider, CompletionParams } from "./provider.js";

export class GeminiProvider implements LlmProvider {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async complete(params: CompletionParams): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: params.model,
      systemInstruction: params.systemPrompt,
    });

    const result = await model.generateContent(params.prompt);
    return result.response.text();
  }
}
