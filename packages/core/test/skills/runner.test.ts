import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import type { LlmProvider, SkillDefinition } from "../../src/index.js";
import { runSkill, extractShellCommands } from "../../src/skills/runner.js";

function mockProvider(response: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function makeSkill(body: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "Test skill",
    location: "/tmp/test/SKILL.md",
    body,
    lookback: "24h",
    requires: { bins: [], env: [] },
    ...overrides,
  };
}

describe("extractShellCommands", () => {
  it("extracts backtick commands from text", () => {
    const body = "1. Run `echo hello` to test\n2. Run `ls -la` for listing\n3. Review the output";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("echo hello");
    expect(cmds).toContain("ls -la");
  });

  it("extracts commands from fenced code blocks", () => {
    const body = "## Instructions\n\n```bash\necho hello\n```\n\nDo stuff.";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("echo hello");
  });

  it("returns empty for body with no commands", () => {
    const cmds = extractShellCommands("Just plain text instructions with `no-command` references.");
    expect(cmds).toEqual([]);
  });

  it("skips code references that aren't commands", () => {
    const body = "Use `functionName()` and `{object}` but run `echo test` too";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("echo test");
    expect(cmds).not.toContain("functionName()");
    expect(cmds).not.toContain("{object}");
  });
});

describe("runSkill", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-runner-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("executes a skill and writes output to hot layer", async () => {
    const skill = makeSkill("## Instructions\n\n1. Run `echo hello world` to get data\n2. Summarize the output");
    const provider = mockProvider("## Summary\n\nHello world was echoed successfully.");

    const state = await runSkill(skill, vault, provider, "test-model");

    expect(state.lastStatus).toBe("success");
    expect(state.entriesCollected).toBe(1);

    const callArgs = (provider.complete as any).mock.calls[0][0];
    expect(callArgs.prompt).toContain("hello world");

    const today = new Date().toISOString().slice(0, 10);
    const hotContent = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(hotContent).toContain("test-skill");
  });

  it("returns error when all commands fail", async () => {
    const skill = makeSkill("1. Run `nonexistent-command-xyz --flag` to get data");
    const provider = mockProvider("No data available.");

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("error");
  });

  it("saves error state when LLM fails", async () => {
    const skill = makeSkill("1. Run `echo test` and summarize");
    const provider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new Error("API key invalid")),
    };

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("error");
    expect(state.lastError).toContain("API key invalid");
  });

  it("writes nothing to hot when LLM returns empty", async () => {
    const skill = makeSkill("1. Run `echo test` and summarize");
    const provider = mockProvider("   ");

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("success");
    expect(state.entriesCollected).toBe(0);
  });
});
