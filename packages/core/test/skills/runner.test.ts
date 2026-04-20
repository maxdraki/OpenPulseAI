import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import type { LlmProvider, SkillDefinition } from "../../src/index.js";
import { runSkill, extractShellCommands } from "../../src/skills/runner.js";
import { loadCollectorState } from "../../src/skills/scheduler.js";

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

  it("extracts commands starting with known shell binaries despite parentheses in content", () => {
    // GraphQL queries contain parentheses like issues(first: 50) which triggered looksLikeCode
    const body = '1. Run `curl -s -X POST https://api.linear.app/graphql -d \'{"query":"{ issues(first: 50) { nodes { id } } }"}\'` to get issues';
    const cmds = extractShellCommands(body);
    expect(cmds.length).toBe(1);
    expect(cmds[0]).toContain("curl");
  });

  it("extracts commands for linear, glab, and notion binaries", () => {
    const body = "1. Run `linear issue query --all-teams` for issues\n2. Run `glab mr list` for MRs\n3. Run `notion search --query test` for pages";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("linear issue query --all-teams");
    expect(cmds).toContain("glab mr list");
    expect(cmds).toContain("notion search --query test");
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

  it("throws and saves error state when all commands fail", async () => {
    const skill = makeSkill("1. Run `nonexistent-command-xyz --flag` to get data");
    const provider = mockProvider("No data available.");

    await expect(runSkill(skill, vault, provider, "test-model")).rejects.toThrow("All commands failed");

    const state = await loadCollectorState(vault, "test-skill");
    expect(state?.lastStatus).toBe("error");
  });

  it("throws and saves error state when LLM fails", async () => {
    const skill = makeSkill("1. Run `echo test` and summarize");
    const provider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new Error("API key invalid")),
    };

    await expect(runSkill(skill, vault, provider, "test-model")).rejects.toThrow("API key invalid");

    const state = await loadCollectorState(vault, "test-skill");
    expect(state?.lastStatus).toBe("error");
    expect(state?.lastError).toContain("API key invalid");
  });

  it("succeeds when some commands fail but not all", async () => {
    const skill = makeSkill("1. Run `echo working` for data\n2. Run `nonexistent-cmd-xyz` for more");
    const provider = mockProvider("Partial data collected.");

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("success");
  });

  it("sanitizes shell metacharacters in text config values", async () => {
    const skill = makeSkill("1. Run `echo {{token}}` to test", {
      config: [{ key: "token", label: "Token", type: "text" }],
      location: "/fake/builtin-skills/test/SKILL.md", // bypass security scanner
    });
    // Write a config with shell injection attempt
    const { writeFile, mkdir } = await import("node:fs/promises");
    const configDir = join(tempDir, "vault", "skill-config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "test-skill.json"),
      JSON.stringify({ token: "good-token;$(whoami)" }),
      "utf-8"
    );

    const provider = mockProvider("Test output.");
    const state = await runSkill(skill, vault, provider, "test-model");

    expect(state.lastStatus).toBe("success");
    // The semicolon and $() should be stripped, preventing injection
    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("good-token");
    expect(prompt).not.toContain(";");
    expect(prompt).not.toContain("$(");
  });

  it("shell-escapes path config values but not text values", async () => {
    const skill = makeSkill("1. Run `echo {{api_key}} {{watch_dir}}` to test", {
      config: [
        { key: "api_key", label: "API Key", type: "text" },
        { key: "watch_dir", label: "Dir", type: "path" },
      ],
      location: "/fake/builtin-skills/test/SKILL.md",
    });
    const { writeFile, mkdir } = await import("node:fs/promises");
    const configDir = join(tempDir, "vault", "skill-config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "test-skill.json"),
      JSON.stringify({ api_key: "sk-abc123", watch_dir: "/my path" }),
      "utf-8"
    );

    const provider = mockProvider("Test.");
    await runSkill(skill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    // Text value: raw (sanitized but not quoted)
    expect(prompt).toContain("sk-abc123");
    // Path value: shell-escaped with single quotes
    expect(prompt).toContain("'/my path'");
  });

  it("writes nothing to hot when LLM returns empty", async () => {
    const skill = makeSkill("1. Run `echo test` and summarize");
    const provider = mockProvider("   ");

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("success");
    expect(state.entriesCollected).toBe(0);
  });
});

describe("runSkill since injection", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-since-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("uses lastRunAt as since_iso when prior state exists", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const stateDir = join(tempDir, "vault", "collector-state");
    await mkdir(stateDir, { recursive: true });
    const lastRunAt = "2026-01-01T10:00:00.000Z";
    await writeFile(
      join(stateDir, "test-skill.json"),
      JSON.stringify({ skillName: "test-skill", lastRunAt, lastStatus: "success", entriesCollected: 1 }),
      "utf-8"
    );
    const skill = makeSkill(
      "1. Run `echo since={{since_iso}}` to show the since date",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = mockProvider("Summary.");
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("since=2026-01-01T10:00:00.000Z");
  });

  it("falls back to lookback when no prior state exists", async () => {
    const skill = makeSkill(
      "1. Run `echo since={{since_date}}` to show the since date",
      { location: "/fake/builtin-skills/test/SKILL.md", lookback: "24h" }
    );
    const provider = mockProvider("Summary.");
    const before = new Date();
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const today = before.toISOString().slice(0, 10);
    const yesterday = new Date(before.getTime() - 86_400_000).toISOString().slice(0, 10);
    const sinceMatch = prompt.match(/since=(\d{4}-\d{2}-\d{2})/);
    expect(sinceMatch).toBeTruthy();
    expect([today, yesterday]).toContain(sinceMatch![1]);
  });

  it("since_days is at least 1 even when lastRunAt is recent", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const stateDir = join(tempDir, "vault", "collector-state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "test-skill.json"),
      JSON.stringify({ skillName: "test-skill", lastRunAt: new Date().toISOString(), lastStatus: "success", entriesCollected: 1 }),
      "utf-8"
    );
    const skill = makeSkill(
      "1. Run `echo days={{since_days}}` to show days",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = mockProvider("Summary.");
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const daysMatch = prompt.match(/days=(\d+)/);
    expect(daysMatch).toBeTruthy();
    expect(parseInt(daysMatch![1])).toBeGreaterThanOrEqual(1);
  });

  it("since_unix is a plausible numeric timestamp", async () => {
    const skill = makeSkill(
      "1. Run `echo ts={{since_unix}}` to show unix timestamp",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = mockProvider("Summary.");
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const tsMatch = prompt.match(/ts=(\d+)/);
    expect(tsMatch).toBeTruthy();
    expect(parseInt(tsMatch![1])).toBeGreaterThan(1_000_000_000);
  });

  it("exposes now_iso and now_date so skills can bound their query windows", async () => {
    const skill = makeSkill(
      "1. Run `echo iso={{now_iso}} date={{now_date}}` to show the now values",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = mockProvider("Summary.");
    const before = new Date();
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const isoMatch = prompt.match(/iso=(\S+)/);
    const dateMatch = prompt.match(/date=(\d{4}-\d{2}-\d{2})/);
    expect(isoMatch).toBeTruthy();
    expect(dateMatch).toBeTruthy();
    expect(dateMatch![1]).toBe(before.toISOString().slice(0, 10));
    expect(Date.parse(isoMatch![1])).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("uses firstRunLookback for the first run when it's set, not lookback", async () => {
    const skill = makeSkill(
      "1. Run `echo since={{since_iso}}` to show the since date",
      { location: "/fake/builtin-skills/test/SKILL.md", lookback: "24h", firstRunLookback: "7d" }
    );
    const provider = mockProvider("Summary.");
    const before = Date.now();
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const sinceMatch = prompt.match(/since=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    expect(sinceMatch).toBeTruthy();
    const sinceMs = Date.parse(sinceMatch![1]);
    // Should be ~7 days ago, not ~24h ago. Allow a generous window.
    const expected7d = before - 7 * 86_400_000;
    expect(sinceMs).toBeGreaterThan(expected7d - 60_000);
    expect(sinceMs).toBeLessThan(expected7d + 60_000);
  });

  it("falls back to lookback on first run when firstRunLookback is absent", async () => {
    const skill = makeSkill(
      "1. Run `echo since={{since_iso}}` to show the since date",
      { location: "/fake/builtin-skills/test/SKILL.md", lookback: "24h" }
    );
    const provider = mockProvider("Summary.");
    const before = Date.now();
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    const sinceMatch = prompt.match(/since=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    expect(sinceMatch).toBeTruthy();
    const sinceMs = Date.parse(sinceMatch![1]);
    // Should be ~24h ago
    const expected24h = before - 86_400_000;
    expect(sinceMs).toBeGreaterThan(expected24h - 60_000);
    expect(sinceMs).toBeLessThan(expected24h + 60_000);
  });

  it("firstRunLookback is ignored once lastRunAt exists", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const stateDir = join(tempDir, "vault", "collector-state");
    await mkdir(stateDir, { recursive: true });
    const lastRunAt = "2026-01-01T10:00:00.000Z";
    await writeFile(
      join(stateDir, "test-skill.json"),
      JSON.stringify({ skillName: "test-skill", lastRunAt, lastStatus: "success", entriesCollected: 1 }),
      "utf-8"
    );
    const skill = makeSkill(
      "1. Run `echo since={{since_iso}}` to show the since date",
      { location: "/fake/builtin-skills/test/SKILL.md", lookback: "24h", firstRunLookback: "30d" }
    );
    const provider = mockProvider("Summary.");
    await runSkill(skill, vault, provider, "model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    // Should use lastRunAt, not firstRunLookback's 30d window
    expect(prompt).toContain("since=2026-01-01T10:00:00.000Z");
  });
});

describe("runSkill error handling", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-err-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("preserves previous successful lastRunAt when a run fails", async () => {
    const { writeFile, mkdir, readFile } = await import("node:fs/promises");
    const stateDir = join(tempDir, "vault", "collector-state");
    await mkdir(stateDir, { recursive: true });
    const priorLastRun = "2026-01-01T10:00:00.000Z";
    await writeFile(
      join(stateDir, "test-skill.json"),
      JSON.stringify({ skillName: "test-skill", lastRunAt: priorLastRun, lastStatus: "success", entriesCollected: 1 }),
      "utf-8"
    );

    const skill = makeSkill(
      "1. Run `echo one`",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = {
      complete: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    } as any;

    await expect(runSkill(skill, vault, provider, "model")).rejects.toThrow("LLM unavailable");

    const raw = await readFile(join(stateDir, "test-skill.json"), "utf-8");
    const state = JSON.parse(raw);
    expect(state.lastStatus).toBe("error");
    expect(state.lastRunAt).toBe(priorLastRun);  // preserved, not advanced
    expect(state.lastError).toContain("LLM unavailable");
  });

  it("sets lastRunAt to null on first-run failure (no prior successful run to preserve)", async () => {
    const { readFile } = await import("node:fs/promises");
    const stateDir = join(tempDir, "vault", "collector-state");

    const skill = makeSkill(
      "1. Run `echo one`",
      { location: "/fake/builtin-skills/test/SKILL.md" }
    );
    const provider = {
      complete: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    } as any;

    await expect(runSkill(skill, vault, provider, "model")).rejects.toThrow("LLM unavailable");

    const raw = await readFile(join(stateDir, "test-skill.json"), "utf-8");
    const state = JSON.parse(raw);
    expect(state.lastStatus).toBe("error");
    expect(state.lastRunAt).toBeNull();
  });
});
