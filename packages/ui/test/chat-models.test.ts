import { describe, it, expect } from "vitest";
import { isAllowedChatModel } from "../server.js";

describe("isAllowedChatModel", () => {
  describe("hosted providers (allowlist enforced)", () => {
    it("accepts known anthropic models", () => {
      expect(isAllowedChatModel("anthropic", "claude-opus-4-7")).toBe(true);
      expect(isAllowedChatModel("anthropic", "claude-sonnet-4-6")).toBe(true);
    });

    it("rejects unknown anthropic models", () => {
      expect(isAllowedChatModel("anthropic", "claude-opus-99")).toBe(false);
      expect(isAllowedChatModel("anthropic", "")).toBe(false);
    });

    it("rejects bogus model names that look like injection", () => {
      expect(isAllowedChatModel("anthropic", "gpt-4o; DROP TABLE")).toBe(false);
      expect(isAllowedChatModel("openai", "../../../etc/passwd")).toBe(false);
    });

    it("rejects an unknown provider entirely", () => {
      expect(isAllowedChatModel("nonexistent", "claude-opus-4-7")).toBe(false);
    });
  });

  describe("ollama (passthrough)", () => {
    it("accepts arbitrary local model names", () => {
      expect(isAllowedChatModel("ollama", "llama3.1:8b")).toBe(true);
      expect(isAllowedChatModel("ollama", "qwen2.5-coder")).toBe(true);
      expect(isAllowedChatModel("ollama", "my/custom-model:latest")).toBe(true);
    });

    it("still rejects empty / overly-long / dangerous strings", () => {
      expect(isAllowedChatModel("ollama", "")).toBe(false);
      expect(isAllowedChatModel("ollama", "x".repeat(81))).toBe(false);
      expect(isAllowedChatModel("ollama", "model name with spaces")).toBe(false);
      expect(isAllowedChatModel("ollama", "model;rm -rf")).toBe(false);
    });
  });
});
