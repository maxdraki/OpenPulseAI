import { describe, it, expect, afterEach } from "vitest";
import { checkEligibility } from "../../src/skills/eligibility.js";
import type { SkillDefinition } from "../../src/index.js";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "Test",
    location: "/tmp/test/SKILL.md",
    body: "Do stuff",
    lookback: "24h",
    requires: { bins: [], env: [] },
    ...overrides,
  };
}

describe("Eligibility", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns eligible when no requirements", async () => {
    const result = await checkEligibility(makeSkill());
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns ineligible when required binary is missing", async () => {
    const result = await checkEligibility(makeSkill({
      requires: { bins: ["nonexistent-binary-xyz"], env: [] },
    }));
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("bin: nonexistent-binary-xyz");
  });

  it("returns eligible when required binary exists", async () => {
    const result = await checkEligibility(makeSkill({
      requires: { bins: ["node"], env: [] },
    }));
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when required env var is missing", async () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const result = await checkEligibility(makeSkill({
      requires: { bins: [], env: ["NONEXISTENT_VAR_XYZ"] },
    }));
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("env: NONEXISTENT_VAR_XYZ");
  });

  it("returns eligible when required env var is set", async () => {
    process.env.TEST_ELIG_KEY = "value";
    const result = await checkEligibility(makeSkill({
      requires: { bins: [], env: ["TEST_ELIG_KEY"] },
    }));
    expect(result.eligible).toBe(true);
    delete process.env.TEST_ELIG_KEY;
  });
});
