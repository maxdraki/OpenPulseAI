import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillsFromDir, loadSkillFromFile, parseFrontmatter } from "../../src/skills/loader.js";

describe("Skill Loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-loader-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe("parseFrontmatter", () => {
    it("parses standard fields", () => {
      const result = parseFrontmatter("name: my-skill\ndescription: Does stuff");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("my-skill");
      expect(result!.description).toBe("Does stuff");
    });

    it("parses OpenPulse extension fields", () => {
      const yaml = 'name: test\ndescription: Test skill\nschedule: "0 22 * * *"\nlookback: 12h\nrequires:\n  bins: [gog, gh]\n  env: [API_KEY]';
      const result = parseFrontmatter(yaml);
      expect(result!.schedule).toBe("0 22 * * *");
      expect(result!.lookback).toBe("12h");
      expect(result!.requires.bins).toEqual(["gog", "gh"]);
      expect(result!.requires.env).toEqual(["API_KEY"]);
    });

    it("returns null for missing required fields", () => {
      expect(parseFrontmatter("name: test")).toBeNull();
      expect(parseFrontmatter("description: test")).toBeNull();
    });

    it("defaults lookback to 24h and requires to empty", () => {
      const result = parseFrontmatter("name: test\ndescription: Test");
      expect(result!.lookback).toBe("24h");
      expect(result!.requires.bins).toEqual([]);
      expect(result!.requires.env).toEqual([]);
    });

    it("parses setup_guide field", () => {
      const yaml = 'name: test\ndescription: Test\nsetup_guide: "Get your key from [Settings](https://example.com)."';
      const result = parseFrontmatter(yaml);
      expect(result!.setupGuide).toBe("Get your key from [Settings](https://example.com).");
    });

    it("returns undefined setupGuide when field is missing", () => {
      const result = parseFrontmatter("name: test\ndescription: Test");
      expect(result!.setupGuide).toBeUndefined();
    });
  });

  describe("loadSkillFromFile", () => {
    it("loads a valid SKILL.md", async () => {
      const skillDir = join(tempDir, "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), '---\nname: my-skill\ndescription: Does stuff\n---\n\n## Instructions\n\nDo the thing.\n', "utf-8");
      const skill = await loadSkillFromFile(join(skillDir, "SKILL.md"));
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("my-skill");
      expect(skill!.body).toContain("Do the thing.");
    });

    it("returns null for file without frontmatter", async () => {
      await writeFile(join(tempDir, "SKILL.md"), "# No frontmatter\n", "utf-8");
      expect(await loadSkillFromFile(join(tempDir, "SKILL.md"))).toBeNull();
    });
  });

  describe("loadSkillsFromDir", () => {
    it("discovers skills in subdirectories", async () => {
      for (const name of ["skill-a", "skill-b"]) {
        const dir = join(tempDir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
      }
      const skills = await loadSkillsFromDir(tempDir);
      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name).sort()).toEqual(["skill-a", "skill-b"]);
    });

    it("returns empty for nonexistent directory", async () => {
      expect(await loadSkillsFromDir("/tmp/nonexistent-xyz")).toEqual([]);
    });
  });
});
