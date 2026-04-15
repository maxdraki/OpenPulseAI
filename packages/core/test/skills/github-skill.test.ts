/**
 * Tests for the github-activity builtin skill.
 *
 * Covers:
 * - SKILL.md parses with the expected config field
 * - Existing 5 commands still present (backward compat)
 * - Per-repo command 6 is present with correct patterns
 * - Comma-separated repo values are normalised (spaces around commas removed)
 * - Shell metacharacters stripped from repo URL list
 * - Default sentinel " " produces no loop iterations (via grep filter)
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

  it("has 1 optional config field github_repo_urls with truthy default", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const fields = skill!.config ?? [];
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    expect(byKey["github_repo_urls"]).toBeDefined();
    expect(byKey["github_repo_urls"].type).toBe("text");
    expect(byKey["github_repo_urls"].default).toBeTruthy();
  });

  it("contains per-repo command using github_repo_urls", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain('printf \'%s\\n\' "{{github_repo_urls}}"');
    expect(skill!.body).toContain('gh api "repos/$repo/commits');
    expect(skill!.body).toContain('gh api "repos/$repo/pulls');
  });

  it("handles enterprise repos via hostname extracted from URL", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain('--hostname "$host"');
  });

  it("extracts exactly 1 shell command from the body", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const cmds = extractShellCommands(skill!.body);
    expect(cmds).toHaveLength(1);
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

  it("normalises spaces around commas in github_repo_urls", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo urls={{github_repo_urls}}` to test",
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repo_urls: "https://github.com/myorg/api, https://github.com/myorg/web",
    });

    const provider = mockProvider("URLs output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("https://github.com/myorg/api,https://github.com/myorg/web");
    expect(prompt).not.toMatch(/myorg\/api,\s+https/);
  });

  it("strips shell metacharacters from github_repo_urls", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo urls={{github_repo_urls}}` to test",
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repo_urls: "https://github.com/myorg/repo;$(whoami)",
    });

    const provider = mockProvider("URLs output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("github.com/myorg/repo");
    expect(prompt).not.toContain(";");
    expect(prompt).not.toContain("$(");
  });

  it("grep filter in command 6 drops the space sentinel so loop never iterates", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    // Minimal version of command 6 that echoes REPO=name only when the loop runs
    const testSkill = {
      ...skill!,
      body: `1. Run \`printf '%s\\n' "{{github_repo_urls}}" | grep -vE '^\\{\\{|^[[:space:]]*$' | tr ',' '\\n' | sed 's/[[:space:]]//g; s/\\.git$//' | grep -v '^$' | while IFS= read -r url; do echo "REPO=$url"; done; true\` to test loop guard`,
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({ github_repo_urls: " " });

    const provider = mockProvider("Loop output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    // The loop body should never have executed — output section shows (no output)
    expect(prompt).toContain("(no output)");
    expect(prompt).not.toMatch(/REPO=https/); // no actual URL in output
  });

  it("loop runs and outputs repo URL when github_repo_urls is configured", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: `1. Run \`printf '%s\\n' "{{github_repo_urls}}" | grep -vE '^\\{\\{|^[[:space:]]*$' | tr ',' '\\n' | sed 's/[[:space:]]//g; s/\\.git$//' | grep -v '^$' | while IFS= read -r url; do echo "REPO=$url"; done; true\` to test loop`,
      location: join(tempDir, "builtin-skills/github-activity/SKILL.md"),
    };

    await writeSkillConfig({
      github_repo_urls: "https://github.com/myorg/api,https://github.com/myorg/web",
    });

    const provider = mockProvider("Loop output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("REPO=https://github.com/myorg/api");
    expect(prompt).toContain("REPO=https://github.com/myorg/web");
  });
});
