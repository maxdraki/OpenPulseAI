/**
 * Tests for the confluence-activity builtin skill.
 *
 * Covers:
 * - SKILL.md parses with the expected config field types
 * - CQL shell command is extractable from the body
 * - `domain` field type strips https:// from user input
 * - Comma-separated space keys are normalised (spaces around commas removed)
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
  "../../builtin-skills/confluence-activity/SKILL.md"
);

function mockProvider(response = "Summary."): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("confluence-activity SKILL.md", () => {
  it("loads and parses the skill file", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("confluence-activity");
    expect(skill!.requires.bins).toContain("curl");
    expect(skill!.setupGuide).toBeDefined();
  });

  it("has the expected config fields with correct types", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const fields = skill!.config ?? [];
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    expect(byKey["confluence_domain"]).toBeDefined();
    expect(byKey["confluence_domain"].type).toBe("domain");

    expect(byKey["confluence_email"]).toBeDefined();
    expect(byKey["confluence_email"].type).toBe("text");

    expect(byKey["confluence_api_token"]).toBeDefined();
    expect(byKey["confluence_api_token"].type).toBe("text");

    expect(byKey["confluence_space_keys"]).toBeDefined();
    expect(byKey["confluence_space_keys"].type).toBe("text");
  });

  it("body contains a CQL curl command targeting the Confluence search API", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    expect(skill!.body).toContain("/wiki/rest/api/content/search");
    expect(skill!.body).toContain("cql=space+IN+");
    expect(skill!.body).toContain("body.export_view");
  });

  it("extracts exactly one shell command from the body", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const cmds = extractShellCommands(skill!.body);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatch(/^curl\s/);
  });
});

describe("confluence-activity config application", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-confluence-"));
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
      join(configDir, "confluence-activity.json"),
      JSON.stringify(values),
      "utf-8"
    );
  }

  it("strips https:// from confluence_domain before interpolation", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    // Override body with a simple echo so the command actually runs
    const testSkill = {
      ...skill!,
      body: "1. Run `echo domain={{confluence_domain}}` to test",
      location: join(tempDir, "builtin-skills/confluence-activity/SKILL.md"), // treated as builtin
    };

    await writeSkillConfig({
      confluence_domain: "https://myteam.atlassian.net",
      confluence_email: "user@example.com",
      confluence_api_token: "token123",
      confluence_space_keys: "ENG",
    });

    const provider = mockProvider("Domain output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("myteam.atlassian.net");
    expect(prompt).not.toContain("https://");
  });

  it("normalises spaces around commas in space keys", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo keys={{confluence_space_keys}}` to test",
      location: join(tempDir, "builtin-skills/confluence-activity/SKILL.md"),
    };

    await writeSkillConfig({
      confluence_domain: "myteam.atlassian.net",
      confluence_email: "user@example.com",
      confluence_api_token: "token123",
      confluence_space_keys: "ENG, DOCS, TEAM",
    });

    const provider = mockProvider("Keys output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("ENG,DOCS,TEAM");
    expect(prompt).not.toMatch(/ENG,\s+DOCS/);
  });

  it("strips shell metacharacters from api token", async () => {
    const skill = await loadSkillFromFile(SKILL_PATH);
    const testSkill = {
      ...skill!,
      body: "1. Run `echo token={{confluence_api_token}}` to test",
      location: join(tempDir, "builtin-skills/confluence-activity/SKILL.md"),
    };

    await writeSkillConfig({
      confluence_domain: "myteam.atlassian.net",
      confluence_email: "user@example.com",
      confluence_api_token: "good-token;$(whoami)",
      confluence_space_keys: "ENG",
    });

    const provider = mockProvider("Token output received.");
    await runSkill(testSkill, vault, provider, "test-model");

    const prompt = (provider.complete as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("good-token");
    expect(prompt).not.toContain(";");
    expect(prompt).not.toContain("$(");
  });
});
