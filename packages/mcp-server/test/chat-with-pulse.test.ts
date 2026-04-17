import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { ChatSession, LlmProvider } from "@openpulse/core";
import { handleChatWithPulse } from "../src/tools/chat-with-pulse.js";

function mockProvider(response: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function queueProvider(responses: string[]): LlmProvider {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return { complete: fn };
}

async function listPending(vault: Vault): Promise<Array<Record<string, unknown>>> {
  try {
    const files = await readdir(vault.pendingDir);
    const out: Array<Record<string, unknown>> = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await readFile(join(vault.pendingDir, f), "utf-8");
      out.push(JSON.parse(raw));
    }
    return out;
  } catch {
    return [];
  }
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

  it("skips judge when < 2 themes consulted", async () => {
    // Only one theme in vault matches the query — judge should not be invoked.
    const provider = mockProvider("A one-theme answer.");
    await handleChatWithPulse(vault, provider, "test-model", {
      message: "auth status",
    });
    // Only one LLM call (the answer). No judge call.
    expect((provider.complete as any).mock.calls.length).toBe(1);
  });

  it("files pending concept page when judge returns yes", async () => {
    // Add a second theme so >= 2 themes are consulted
    await writeTheme(vault, "project-billing", "Billing migration to Stripe is ongoing.");

    // First LLM call = answer; second call = judge. Judge returns "yes".
    const provider = queueProvider([
      "Auth and billing both rely on JWT session tokens.",
      JSON.stringify({
        verdict: "yes",
        proposed_name: "jwt-session-tokens",
        one_line_definition: "JWT tokens used across auth and billing.",
        refined_content: "## Definition\n\nShared JWT token model.\n\n## Key Claims\n\n## Related Concepts\n\n## Sources\n",
      }),
    ]);

    const result = await handleChatWithPulse(vault, provider, "test-model", {
      message: "how do auth and billing share tokens?",
    });

    expect(result.content[0].text).toContain("Filed [[jwt-session-tokens]]");

    const pending = await listPending(vault);
    expect(pending.length).toBe(1);
    expect(pending[0].theme).toBe("jwt-session-tokens");
    expect(pending[0].type).toBe("concept");
    expect(pending[0].querybackSource).toBeDefined();
    expect((pending[0].querybackSource as any).question).toBe("how do auth and billing share tokens?");
    expect(Array.isArray((pending[0].querybackSource as any).themesConsulted)).toBe(true);
    expect(((pending[0].querybackSource as any).themesConsulted as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it("stores pendingFile in session when judge returns maybe", async () => {
    await writeTheme(vault, "project-billing", "Billing migration to Stripe is ongoing.");

    const provider = queueProvider([
      "Both rely on shared tokens.",
      JSON.stringify({
        verdict: "maybe",
        proposed_name: "token-sharing",
        one_line_definition: "Token sharing across services.",
        refined_content: "## Definition\n\nToken sharing.\n\n## Key Claims\n\n## Related Concepts\n\n## Sources\n",
      }),
    ]);

    const result = await handleChatWithPulse(vault, provider, "test-model", {
      message: "how do auth and billing share tokens?",
    });

    // Response includes the file-offer prompt
    expect(result.content[0].text).toContain("file: yes");
    expect(result.content[0].text).toContain("[[token-sharing]]");

    // No pending file written yet
    const pending = await listPending(vault);
    expect(pending.length).toBe(0);

    // Session has pendingFile stashed
    const sessionRaw = await readFile(join(vault.sessionsDir, `${result.sessionId}.json`), "utf-8");
    const session = JSON.parse(sessionRaw) as ChatSession;
    expect(session.pendingFile).toBeDefined();
    expect(session.pendingFile?.name).toBe("token-sharing");
    expect(session.pendingFile?.question).toBe("how do auth and billing share tokens?");
  });

  it("creates pending update when user replies 'file: yes'", async () => {
    await writeTheme(vault, "project-billing", "Billing migration to Stripe is ongoing.");

    // Turn 1: answer + judge verdict "maybe"
    const provider = queueProvider([
      "Both rely on shared tokens.",
      JSON.stringify({
        verdict: "maybe",
        proposed_name: "token-sharing",
        one_line_definition: "Token sharing.",
        refined_content: "## Definition\n\nToken sharing.\n\n## Key Claims\n\n## Related Concepts\n\n## Sources\n",
      }),
    ]);
    const r1 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "how do auth and billing share tokens?",
    });

    // Turn 2: user replies "file: yes" — should hit the early exit path, no LLM calls
    const callCountBefore = (provider.complete as any).mock.calls.length;
    const r2 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "file: yes",
      sessionId: r1.sessionId,
    });

    expect(r2.content[0].text).toContain("Filed [[token-sharing]]");
    // No new LLM calls should have been made on turn 2
    expect((provider.complete as any).mock.calls.length).toBe(callCountBefore);

    // Pending file now exists
    const pending = await listPending(vault);
    expect(pending.length).toBe(1);
    expect(pending[0].theme).toBe("token-sharing");
    expect(pending[0].type).toBe("concept");
    expect(pending[0].querybackSource).toBeDefined();

    // Session pendingFile cleared
    const sessionRaw = await readFile(join(vault.sessionsDir, `${r2.sessionId}.json`), "utf-8");
    const session = JSON.parse(sessionRaw) as ChatSession;
    expect(session.pendingFile).toBeUndefined();
  });

  it("returns response unchanged when judge returns no", async () => {
    await writeTheme(vault, "project-billing", "Billing migration to Stripe is ongoing.");

    const provider = queueProvider([
      "Some ephemeral Q&A answer.",
      JSON.stringify({
        verdict: "no",
        proposed_name: null,
        one_line_definition: null,
        refined_content: null,
      }),
    ]);

    const result = await handleChatWithPulse(vault, provider, "test-model", {
      message: "what's going on with auth and billing today?",
    });

    expect(result.content[0].text).toContain("Some ephemeral Q&A answer.");
    expect(result.content[0].text).not.toContain("Filed [[");
    expect(result.content[0].text).not.toContain("file: yes");

    const pending = await listPending(vault);
    expect(pending.length).toBe(0);
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
