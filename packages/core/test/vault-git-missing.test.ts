import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import { ensureVaultRepo, commitVault } from "../src/vault-git.js";

// This file is isolated from vault-git.test.ts (separate module graph per
// vitest test file) so the module-level "git unavailable" latch it triggers
// here never leaks into the happy-path tests.
describe("vault-git — graceful degradation when git is unavailable", () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-vault-git-missing-"));
    originalPath = process.env.PATH;
    // Remove every directory from PATH so `git` cannot be resolved by execFile.
    process.env.PATH = "";
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ensureVaultRepo never throws when the git binary is missing", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await expect(ensureVaultRepo(vault)).resolves.toBeUndefined();
  });

  it("does not create a .git directory when git is unavailable", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);

    const { stat } = await import("node:fs/promises");
    await expect(stat(join(tempDir, "vault", ".git"))).rejects.toThrow();
  });

  it("commitVault never throws when the git binary is missing", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);
    await expect(commitVault(vault, "should be a silent no-op")).resolves.toBeUndefined();
  });
});
