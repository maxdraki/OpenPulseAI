/**
 * Tests for the github-activity builtin skill.
 *
 * Covers:
 * - SKILL.md parses with the expected config field types
 * - Existing 5 commands still present (backward compat)
 * - Per-repo commands 6 and 7 are present with correct patterns
 * - `github_enterprise_host` domain field strips https:// prefix
 * - Comma-separated repo values are normalised (spaces around commas removed)
 * - Shell metacharacters stripped from repo list
 * - Default sentinel "," produces no loop iterations (via grep filter)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillFromFile } from "../../src/skills/loader.js";
import { extractShellCommands, runSkill } from "../../src/skills/runner.js";
import { Vault } from "../../src/vault.js";
import type { LlmProvider } from "../../src/index.js";

const SKILL_PATH = resolve(
  new URL(".", import.meta.url).pathname,
  "../../builtin-skills/github-activity/SKILL.md"
);

function mockProvider(response = "Summary."): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("github-activity SKILL.md", () => {
  it("loads and parses the skill file", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("github-activity");
    expect(skill!.requires.bins).toContain("gh");
    expect(skill!.setupGuide).toBeDefined();
  });

  it("has 3 new optional config fields with correct types and truthy defaults", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const fields = skill!.config ?? [];
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    expect(byKey["github_repos"]).toBeDefined();
    expect(byKey["github_repos"].type).toBe("text");
    expect(byKey["github_repos"].default).toBeTruthy();

    expect(byKey["github_enterprise_host"]).toBeDefined();
    expect(byKey["github_enterprise_host"].type).toBe("domain");
    expect(byKey["github_enterprise_host"].default).toBeTruthy();

    expect(byKey["github_enterprise_repos"]).toBeDefined();
    expect(byKey["github_enterprise_repos"].type).toBe("text");
    expect(byKey["github_enterprise_repos"].default).toBeTruthy();
  });

  it("still contains all 5 original commands", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain("gh api events");
    expect(skill!.body).toContain("gh pr list --author @me");
    expect(skill!.body).toContain("reviewed-by:@me");
    expect(skill!.body).toContain("gh api notifications");
    expect(skill!.body).toContain("gh api user/repos");
  });

  it("contains per-repo command patterns for github.com", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain('printf \'%s\\n\' "{{github_repos}}"');
    expect(skill!.body).toContain('gh api "repos/$repo/commits');
    expect(skill!.body).toContain('gh api "repos/$repo/pulls');
  });

  it("contains enterprise command with --hostname flag", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain('printf \'%s\\n\' "{{github_enterprise_repos}}"');
    expect(skill!.body).toContain('--hostname "{{github_enterprise_host}}"');
  });

  it("extracts exactly 7 shell commands from the body", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const cmds = extractShellCommands(skill!.body);
    expect(cmds).toHaveLength(7);
  });
});

describe("github-activity config application", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-github-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  async function writeSkillConfig(values: Record<string, string>) {
    const configDir = join(tempDir, "vault", "skill-config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "github-activity.json"),
      JSON.stringify(values),
      "utf-8"
    );
  }

  it("strips https:// from github_enterprise_host before interpolation", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo host={{github_enterprise_host}}` to test",
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repos: ",",
      github_enterprise_host: "https://github.mycompany.com",
      github_enterprise_repos: ",",
    });

    const provider = mockProvider("Host output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("github.mycompany.com");
    expect(prompt).not.toContain("https://");
  });

  it("normalises spaces around commas in github_repos", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo repos={{github_repos}}` to test",
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repos: "myorg/api, myorg/web, myorg/docs",
      github_enterprise_host: "github.com",
      github_enterprise_repos: ",",
    });

    const provider = mockProvider("Repos output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("myorg/api,myorg/web,myorg/docs");
    expect(prompt).not.toMatch(/myorg\/api,\s+myorg/);
  });

  it("strips shell metacharacters from github_repos", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo repos={{github_repos}}` to test",
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repos: "myorg/repo;$(whoami)",
      github_enterprise_host: "github.com",
      github_enterprise_repos: ",",
    });

    const provider = mockProvider("Repos output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("myorg/repo");
    expect(prompt).not.toContain(";");
    expect(prompt).not.toContain("$(");
  });

  it("grep filter in command 6 drops the comma sentinel so loop never iterates", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    // Use a minimal version of command 6 that echoes REPO=name only when the loop runs
    const testSkill = {
      ...skill!,
      body: `1. Run \`printf '%s\\n' "{{github_repos}}" | grep -vE '^\\{\\{|^[,[:space:]]*$' | tr ',' '\\n' | grep -v '^[[:space:]]*$' | while IFS= read -r repo; do repo=$(echo "$repo" | tr -d ' '); echo "REPO=$repo"; done; true\` to test loop guard`,
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repos: ",",
      github_enterprise_host: "github.com",
      github_enterprise_repos: ",",
    });

    const provider = mockProvider("Loop output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    // The loop body should never have executed — output section shows (no output)
    // (The command text itself contains "REPO=$repo" but the actual output is empty)
    expect(prompt).toContain("(no output)");
    expect(prompt).not.toMatch(/REPO=[a-zA-Z]/); // no actual repo name in output
  });

  it("loop runs and outputs repo name when github_repos is configured", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: `1. Run \`printf '%s\\n' "{{github_repos}}" | grep -vE '^\\{\\{|^[,[:space:]]*$' | tr ',' '\\n' | grep -v '^[[:space:]]*$' | while IFS= read -r repo; do repo=$(echo "$repo" | tr -d ' '); echo "REPO=$repo"; done; true\` to test loop`,
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repos: "myorg/api,myorg/web",
      github_enterprise_host: "github.com",
      github_enterprise_repos: ",",
    });

    const provider = mockProvider("Loop output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("REPO=myorg/api");
    expect(prompt).toContain("REPO=myorg/web");
  });
});
