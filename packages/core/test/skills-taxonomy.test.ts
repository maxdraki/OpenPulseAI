import { describe, it, expect } from "vitest";
import {
  SEED_SKILLS,
  isKnownSkill,
  isValidSkillTag,
  normaliseSkill,
} from "../src/skills-taxonomy.js";

describe("skills taxonomy", () => {
  it("ships a reasonable seed list covering languages, platforms, activities, and domains", () => {
    expect(SEED_SKILLS).toContain("typescript");
    expect(SEED_SKILLS).toContain("python");
    expect(SEED_SKILLS).toContain("pr-review");
    expect(SEED_SKILLS).toContain("system-design");
    expect(SEED_SKILLS).toContain("observability");
    expect(SEED_SKILLS.length).toBeGreaterThanOrEqual(30);
  });

  it("every seed tag is itself a valid tag", () => {
    for (const tag of SEED_SKILLS) {
      expect(isValidSkillTag(tag)).toBe(true);
    }
  });

  describe("isValidSkillTag", () => {
    it("accepts lowercase-kebab-case", () => {
      expect(isValidSkillTag("typescript")).toBe(true);
      expect(isValidSkillTag("pr-review")).toBe(true);
      expect(isValidSkillTag("data-pipeline")).toBe(true);
    });

    it("rejects empty, whitespace, or too-short tags", () => {
      expect(isValidSkillTag("")).toBe(false);
      expect(isValidSkillTag(" ")).toBe(false);
      expect(isValidSkillTag("a")).toBe(false);
    });

    it("rejects camelCase, spaces, leading dashes, or underscores", () => {
      expect(isValidSkillTag("TypeScript")).toBe(false);
      expect(isValidSkillTag("pr review")).toBe(false);
      expect(isValidSkillTag("-leading")).toBe(false);
      expect(isValidSkillTag("with_underscore")).toBe(false);
    });

    it("rejects overly long tags (likely hallucinated phrases)", () => {
      expect(isValidSkillTag("a".repeat(41))).toBe(false);
    });
  });

  describe("isKnownSkill", () => {
    it("matches seed tags after case-insensitive normalisation", () => {
      expect(isKnownSkill("typescript")).toBe(true);
      expect(isKnownSkill("  TypeScript  ")).toBe(true);
    });

    it("returns false for classifier-proposed new tags", () => {
      expect(isKnownSkill("llm-prompting")).toBe(false);
    });
  });

  describe("normaliseSkill", () => {
    it("lowercases and hyphenates whitespace", () => {
      expect(normaliseSkill("PR Review")).toBe("pr-review");
      expect(normaliseSkill("System  Design")).toBe("system-design");
    });

    it("returns null for invalid inputs", () => {
      expect(normaliseSkill("")).toBeNull();
      expect(normaliseSkill("x")).toBeNull();
      expect(normaliseSkill(123 as unknown as string)).toBeNull();
    });

    it("recovers from sloppy whitespace and edge-hyphens", () => {
      expect(normaliseSkill("  -System Design-  ")).toBe("system-design");
      expect(normaliseSkill("--PR--Review--")).toBe("pr-review");
    });
  });
});
