import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBin, resolveBuiltinSkillsDir } from "../server.js";

describe("resolveBin (dream/skills CLI resolution)", () => {
  const ENV_KEY = "OPENPULSE_BIN_DIR";
  const original = process.env[ENV_KEY];
  let binDir: string;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), "openpulse-bin-dir-"));
  });

  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    await rm(binDir, { recursive: true, force: true });
  });

  it("falls back to `node <dev-relative-path>` when OPENPULSE_BIN_DIR is unset", () => {
    delete process.env[ENV_KEY];
    const { command, args } = resolveBin("openpulse-dream", "index.js");
    expect(command).toBe("node");
    expect(args).toEqual([join(process.cwd(), "..", "dream", "dist", "index.js")]);
  });

  it("falls back to the dev-relative path when the named binary doesn't exist in OPENPULSE_BIN_DIR", () => {
    process.env[ENV_KEY] = binDir; // empty dir — binary not present
    const { command, args } = resolveBin("openpulse-dream", "index.js");
    expect(command).toBe("node");
    expect(args).toEqual([join(process.cwd(), "..", "dream", "dist", "index.js")]);
  });

  it("invokes the bundled sidecar binary directly (no `node` prefix) when it exists under OPENPULSE_BIN_DIR", async () => {
    process.env[ENV_KEY] = binDir;
    const binPath = join(binDir, "openpulse-dream");
    await writeFile(binPath, "#!/bin/sh\nexit 0\n");
    await chmod(binPath, 0o755);

    const { command, args } = resolveBin("openpulse-dream", "index.js");
    expect(command).toBe(binPath);
    expect(args).toEqual([]);
  });

  it("resolves each dream CLI's own bin name independently (aigis-rollup doesn't fall back to dream's binary)", async () => {
    process.env[ENV_KEY] = binDir;
    const rollupPath = join(binDir, "openpulse-aigis-rollup");
    await writeFile(rollupPath, "#!/bin/sh\nexit 0\n");
    await chmod(rollupPath, 0o755);
    // openpulse-dream deliberately NOT created in this bin dir.

    const rollup = resolveBin("openpulse-aigis-rollup", "aigis-rollup-cli.js");
    expect(rollup.command).toBe(rollupPath);

    const dream = resolveBin("openpulse-dream", "index.js");
    expect(dream.command).toBe("node"); // falls back — not found under binDir
  });
});

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

  it("falls back to the process.cwd()-relative dev path when unset", () => {
    delete process.env[ENV_KEY];
    expect(resolveBuiltinSkillsDir()).toBe(join(process.cwd(), "..", "core", "builtin-skills"));
  });
});
