import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vault } from "../src/vault.js";
import { ensureVaultRepo, commitVault } from "../src/vault-git.js";

const execFileAsync = promisify(execFile);

async function gitLog(gitRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "log", "--oneline"]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function gitConfigGet(gitRoot: string, key: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "config", key]);
    return stdout.trim();
  } catch {
    return "";
  }
}

describe("vault-git", () => {
  let tempDir: string;
  let gitRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-vault-git-"));
    gitRoot = join(tempDir, "vault");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("initializes a git repo rooted at vault/ with an initial commit", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);

    const stats = await stat(join(gitRoot, ".git"));
    expect(stats.isDirectory()).toBe(true);

    const log = await gitLog(gitRoot);
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("writes a .gitignore covering transient/lock/log files", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);

    const gitignore = await readFile(join(gitRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain(".dream.lock");
    expect(gitignore).toContain("hot/.processed.json");
  });

  it("is idempotent — calling ensureVaultRepo twice does not error or duplicate init", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);
    const firstLog = await gitLog(gitRoot);

    await ensureVaultRepo(vault);
    const secondLog = await gitLog(gitRoot);

    expect(secondLog.length).toBe(firstLog.length);
  });

  it("leaves an already-self-contained vault repo's config alone", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    // Pre-initialize the vault dir as a user-managed git repo with a custom identity.
    await execFileAsync("git", ["-C", gitRoot, "init"]);
    await execFileAsync("git", ["-C", gitRoot, "config", "user.name", "Custom User"]);
    await execFileAsync("git", ["-C", gitRoot, "config", "user.email", "custom@example.com"]);

    await ensureVaultRepo(vault);

    // Config must be untouched — no forced re-init or ownership change.
    expect(await gitConfigGet(gitRoot, "user.name")).toBe("Custom User");
    expect(await gitConfigGet(gitRoot, "user.email")).toBe("custom@example.com");
  });

  it("self-contains the vault repo even when it lives inside a PARENT git repo", async () => {
    // Simulate the vault living inside a directory that is itself under git
    // (e.g. the user's home directory), which must NOT be mistaken for the
    // vault's own repo — the vault dir must get its own independent .git.
    await execFileAsync("git", ["-C", tempDir, "init"]);

    const vault = new Vault(tempDir);
    await vault.init();

    await ensureVaultRepo(vault);

    const stats = await stat(join(gitRoot, ".git"));
    expect(stats.isDirectory()).toBe(true);

    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "rev-parse", "--show-toplevel"]);
    const { realpath } = await import("node:fs/promises");
    expect(await realpath(stdout.trim())).toBe(await realpath(gitRoot));
  });

  it("commitVault stages and commits changes with the given message", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    await writeFile(join(vault.warmDir, "example.md"), "# Example\n", "utf-8");
    await commitVault(vault, "test: add example theme");

    const log = await gitLog(gitRoot);
    expect(log[0]).toContain("test: add example theme");
  });

  it("commitVault is a clean no-op when there is nothing to stage", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    const before = await gitLog(gitRoot);
    await commitVault(vault, "test: nothing changed");
    const after = await gitLog(gitRoot);

    expect(after.length).toBe(before.length);
  });

  it("commitVault uses an explicit local identity so it works with no global git config", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    await writeFile(join(vault.warmDir, "identity-check.md"), "# Identity check\n", "utf-8");
    await commitVault(vault, "test: identity check");

    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "log", "-1", "--format=%an <%ae>"]);
    expect(stdout.trim()).toBe("OpenPulse <openpulse@local>");
  });

  it("commitVault does not touch files outside the vault dir", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    // A sibling file outside vault/ must never be staged by a vault commit.
    const outsideFile = join(tempDir, "outside.txt");
    await writeFile(outsideFile, "not part of the vault", "utf-8");

    await writeFile(join(vault.warmDir, "in-vault.md"), "# In vault\n", "utf-8");
    await commitVault(vault, "test: scoped commit");

    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "show", "--stat", "HEAD"]);
    expect(stdout).not.toContain("outside.txt");
  });
});
