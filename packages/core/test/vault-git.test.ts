import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Vault } from "../src/vault.js";
import { ensureVaultRepo, commitVault, vaultLogSince } from "../src/vault-git.js";

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
    // M2: orchestrator heartbeat state (+ its *.tmp siblings, already covered
    // by the "*.tmp" pattern) must not pollute vault commit history.
    expect(gitignore).toContain("orchestrator-state.json");
    expect(gitignore).toContain("*.tmp");
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

describe("vaultLogSince", () => {
  let tempDir: string;
  let gitRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-vault-logsince-"));
    gitRoot = join(tempDir, "vault");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns [] gracefully when the vault directory exists but isn't a git repo", async () => {
    // vault/ exists on disk but was never `git init`'d (skips Vault.init(),
    // which would call ensureVaultRepo) — git exits non-zero ("not a git
    // repository"), which vaultLogSince must treat as "nothing to report",
    // not throw. Deliberately NOT using a missing directory here: that would
    // make the `git` spawn itself fail with ENOENT, which vault-git.ts
    // (correctly, for the real "git binary missing" case) latches as
    // "git unavailable" for the rest of the process — that latch would then
    // spuriously break every other test in this file that runs afterward.
    const bareRoot = await mkdtemp(join(tmpdir(), "openpulse-nogit-"));
    await mkdir(join(bareRoot, "vault"), { recursive: true });
    const bareVault = new Vault(bareRoot);
    const result = await vaultLogSince(bareVault, new Date(0).toISOString());
    expect(result).toEqual([]);
  });

  it("summarizes commit subjects and the warm themes each commit touched, since a given date", async () => {
    // Several sequential git subprocess calls (init + 2 raw + 2 commitVault) —
    // this sandbox's git/fs is slow enough that the default 5s test timeout
    // is occasionally too tight; other tests in this file get away with it
    // only because they invoke far fewer git operations.
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    // Old commit, before our "since" cutoff. Backdated via env vars on a
    // direct `git commit` (not `commitVault` + `--amend --date=`, which in
    // some environments blocks on a GPG-signing prompt with no TTY attached).
    await writeFile(join(vault.warmDir, "old-theme.md"), "# Old\n", "utf-8");
    await execFileAsync("git", [
      "-C", gitRoot,
      "-c", "user.name=OpenPulse", "-c", "user.email=openpulse@local", "-c", "commit.gpgsign=false",
      "add", "-A", "--", ".",
    ], { timeout: 10000 });
    await execFileAsync("git", [
      "-C", gitRoot,
      "-c", "user.name=OpenPulse", "-c", "user.email=openpulse@local", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "-m", "chore: old theme",
    ], {
      timeout: 10000,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      },
    });

    const sinceIso = "2026-01-01T00:00:00Z";

    await writeFile(join(vault.warmDir, "project-a.md"), "# Project A\n", "utf-8");
    await writeFile(join(vault.warmDir, "index.md"), "# Index\n", "utf-8");
    await commitVault(vault, "feat: synthesize project-a");

    await writeFile(join(vault.warmDir, "project-a.md"), "# Project A v2\n", "utf-8");
    await writeFile(join(vault.warmDir, "concept-b.md"), "# Concept B\n", "utf-8");
    await commitVault(vault, "feat: synthesize project-a and concept-b");

    const result = await vaultLogSince(vault, sinceIso);

    // Old pre-cutoff commit excluded.
    expect(result.some((c) => c.subject.includes("old theme"))).toBe(false);

    const subjects = result.map((c) => c.subject);
    expect(subjects).toContain("feat: synthesize project-a");
    expect(subjects).toContain("feat: synthesize project-a and concept-b");

    const secondCommit = result.find((c) => c.subject === "feat: synthesize project-a and concept-b");
    expect(secondCommit).toBeDefined();
    expect(secondCommit!.themes.sort()).toEqual(["concept-b", "project-a"]);
    // index.md is a generated file, never a theme.
    expect(secondCommit!.themes).not.toContain("index");
  }, 20000);

  it("returns [] when sinceIso is in the future (no commits qualify)", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    await ensureVaultRepo(vault);

    const result = await vaultLogSince(vault, new Date(Date.now() + 86_400_000).toISOString());
    expect(result).toEqual([]);
  });
});
