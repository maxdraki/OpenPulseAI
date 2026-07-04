import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { resolveBuiltinSkillsDir } from "../../src/skills/run.js";

describe("resolveBuiltinSkillsDir", () => {
  const ENV_KEY = "OPENPULSE_BUILTIN_SKILLS_DIR";
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("prefers an explicit OPENPULSE_BUILTIN_SKILLS_DIR override", () => {
    process.env[ENV_KEY] = "/some/resource/dir/builtin-skills";
    expect(resolveBuiltinSkillsDir()).toBe("/some/resource/dir/builtin-skills");
  });

  it("falls back to the import.meta.url-relative path when no override is set", () => {
    delete process.env[ENV_KEY];
    // Running as real ESM under vitest, so import.meta.url is a genuine
    // file:// URL — this resolves to the real packages/core/builtin-skills
    // directory (this file lives at packages/core/test/skills/, three
    // levels below the run.ts module at packages/core/src/skills/, so the
    // resolved path should end with exactly that suffix).
    const resolved = resolveBuiltinSkillsDir();
    expect(resolved.endsWith(join("core", "builtin-skills"))).toBe(true);
  });
});
