import { describe, it, expect } from "vitest";
import { OllamaProvider } from "../../src/llm/ollama.js";

describe("OllamaProvider", () => {
  it("instantiates with default base URL", () => {
    const provider = new OllamaProvider();
    expect(provider).toBeDefined();
  });

  it("instantiates with custom base URL", () => {
    const provider = new OllamaProvider("http://192.168.1.100:11434");
    expect(provider).toBeDefined();
  });

  it("implements complete() method", () => {
    const provider = new OllamaProvider();
    expect(typeof provider.complete).toBe("function");
  });
});
