import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { LlmProvider } from "@openpulse/core";
import { handleChatWithPulse } from "../src/tools/chat-with-pulse.js";

function mockProvider(response: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("chat_with_pulse tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-chat-"));
    vault = new Vault(tempDir);
    await vault.init();
    await writeTheme(vault, "project-auth", "Login page refactored. JWT implemented.");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates new session and returns response with sessionId", async () => {
    const provider = mockProvider("The auth project is on track.");
    const result = await handleChatWithPulse(vault, provider, "test-model", {
      message: "What's the auth status?",
    });
    expect(result.content[0].text).toContain("The auth project is on track.");
    expect(result.sessionId).toBeTruthy();
  });

  it("continues existing session", async () => {
    const provider = mockProvider("First response.");
    const r1 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "Hello",
    });

    (provider.complete as any).mockResolvedValue("Follow-up response.");
    const r2 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "Tell me more",
      sessionId: r1.sessionId,
    });
    expect(r2.content[0].text).toContain("Follow-up response.");
    expect(r2.sessionId).toBe(r1.sessionId);
  });

  it("includes warm theme context in LLM prompt", async () => {
    const provider = mockProvider("Answer.");
    await handleChatWithPulse(vault, provider, "test-model", {
      message: "auth status",
    });
    const callArgs = (provider.complete as any).mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain("Login page refactored");
  });

  it("uses index.md to find relevant themes when available", async () => {
    // Write a second theme and an index.md
    await writeTheme(vault, "hiring", "Hiring pipeline is active. 5 candidates in review.");
    const indexContent = `# OpenPulse Knowledge Base\n\n- [[project-auth]] — Login page refactored\n- [[hiring]] — Hiring pipeline active\n`;
    await writeFile(join(vault.warmDir, "index.md"), indexContent, "utf-8");

    const provider = mockProvider("Hiring update.");
    await handleChatWithPulse(vault, provider, "test-model", {
      message: "What's happening with hiring?",
    });
    const callArgs = (provider.complete as any).mock.calls[0][0];
    // Should load hiring theme via index lookup, not auth
    expect(callArgs.systemPrompt).toContain("Hiring pipeline");
  });
});
