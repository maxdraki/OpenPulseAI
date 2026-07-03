/**
 * Git-backed vault history — every approve/merge/dream-pipeline write gets an
 * automatic commit so the vault has an audit trail and a rollback path (see
 * `.superpowers/sdd/task-5-brief.md`).
 *
 * Shells out to the system `git` binary via `execFile` (same pattern as the
 * skills runner, see `skills/runner.ts`) rather than pulling in a git npm
 * dependency. The repo is always rooted at `<vault.root>/vault` — the
 * directory that actually holds hot/warm/cold/sessions/logs — NOT at
 * `vault.root` itself (which may also contain unrelated files like
 * `config.yaml` or user skills) and NEVER at any ancestor of it.
 *
 * Graceful degradation is mandatory: vault operations must never fail
 * because of git. Every exported function swallows all errors, logs a
 * warning at most once per process, and otherwise no-ops.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { vaultLog } from "./logger.js";
import type { Vault } from "./vault.js";

const execFileAsync = promisify(execFile);

/** Once true, every git call short-circuits without touching the filesystem
 *  or spawning a process again — set the first time `git` itself turns out
 *  to be missing (ENOENT). */
let gitUnavailable = false;
let warnedUnavailable = false;

/** Vault dirs (by resolved `<root>/vault` path) already confirmed to have a
 *  usable git repo — avoids re-running `rev-parse`/`show-toplevel` on every
 *  `Vault.init()` call (which happens per-request in the dev API server). */
const ensuredRoots = new Set<string>();

async function warnOnce(message: string, detail?: string): Promise<void> {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(`[vault-git] ${message}${detail ? `: ${detail}` : ""}`);
  try {
    await vaultLog("warn", `[vault-git] ${message}`, detail);
  } catch {
    // vaultLog already never throws, but this is belt-and-braces: a warning
    // about git must never itself become a fatal error.
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` with cwd rooted at `cwd`. Returns `null` if the `git`
 *  binary is missing (ENOENT) — this also latches `gitUnavailable` so every
 *  subsequent call across all vault-git functions short-circuits for the
 *  rest of the process. A non-zero exit for any OTHER reason (e.g. "not a
 *  git repository", a merge conflict) is returned as data, not thrown —
 *  callers decide whether that's expected. */
async function runGit(cwd: string, args: string[]): Promise<GitResult | null> {
  if (gitUnavailable) return null;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: 15000 });
    return { code: 0, stdout, stderr };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (err?.code === "ENOENT") {
      gitUnavailable = true;
      await warnOnce("git binary not found — vault history disabled for this process");
      return null;
    }
    return {
      code: typeof err?.code === "number" ? err.code : 1,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? String(err?.message ?? e),
    };
  }
}

function gitRoot(vault: Vault): string {
  return join(vault.root, "vault");
}

async function tryRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

const VAULT_GITIGNORE = ["logs/", ".dream.lock", "hot/.processed.json", "*.tmp", ""].join("\n");

/**
 * Adopts the vault directory as a self-contained git repo, if it isn't one
 * already:
 *   - Not inside any git work tree → `git init` + write `.gitignore` +
 *     initial commit.
 *   - Inside a work tree whose toplevel IS the vault dir itself → already a
 *     user-managed repo; leave its config alone entirely.
 *   - Inside a work tree whose toplevel is a PARENT of the vault dir (e.g.
 *     the vault lives under a git-tracked home directory) → still
 *     `git init` the vault dir so vault commits stay self-contained and
 *     never touch the parent repo.
 *
 * Safe to call on every `Vault.init()` — cheap no-op once a root has been
 * confirmed, and never throws (git being missing/broken degrades silently).
 */
export async function ensureVaultRepo(vault: Vault): Promise<void> {
  if (gitUnavailable) return;
  const root = gitRoot(vault);
  if (ensuredRoots.has(root)) return;

  try {
    await mkdir(root, { recursive: true });

    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside) return; // git missing

    if (inside.code === 0 && inside.stdout.trim() === "true") {
      const toplevel = await runGit(root, ["rev-parse", "--show-toplevel"]);
      if (toplevel && toplevel.code === 0) {
        const [reportedRoot, resolvedGitRoot] = await Promise.all([
          tryRealpath(toplevel.stdout.trim()),
          tryRealpath(root),
        ]);
        if (reportedRoot === resolvedGitRoot) {
          // Already a self-contained, user-managed repo. Leave it alone.
          ensuredRoots.add(root);
          return;
        }
      }
      // Inside a work tree, but it's an ancestor repo (e.g. the vault lives
      // under a git-tracked home dir) — fall through to `git init` so vault
      // commits stay scoped to the vault dir, never the parent repo.
    }

    const init = await runGit(root, ["init"]);
    if (!init) return; // git missing
    if (init.code !== 0) {
      await warnOnce("git init failed — vault history disabled", init.stderr);
      return;
    }

    try {
      await writeFile(join(root, ".gitignore"), VAULT_GITIGNORE, "utf-8");
    } catch {
      // Best-effort — a missing .gitignore doesn't block adoption.
    }

    await commitVault(vault, "chore: initial vault commit");
    ensuredRoots.add(root);
  } catch (e: unknown) {
    await warnOnce("unexpected error ensuring vault repo — vault history disabled", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Stages every change under `<vault.root>/vault` and commits it with
 * `message`, using an explicit local identity so it works on machines with
 * no global `git user.name`/`user.email` configured. Cleanly no-ops when
 * there is nothing to stage, and never throws — see module docstring.
 */
export async function commitVault(vault: Vault, message: string): Promise<void> {
  if (gitUnavailable) return;
  const root = gitRoot(vault);

  try {
    const add = await runGit(root, ["add", "-A", "--", "."]);
    if (!add) return; // git missing
    if (add.code !== 0) {
      await warnOnce("git add failed", add.stderr);
      return;
    }

    const status = await runGit(root, ["status", "--porcelain"]);
    if (!status) return;
    if (status.code !== 0) {
      await warnOnce("git status failed", status.stderr);
      return;
    }
    if (status.stdout.trim() === "") return; // nothing to commit

    const commit = await runGit(root, [
      "-c", "user.name=OpenPulse",
      "-c", "user.email=openpulse@local",
      "commit", "--quiet", "-m", message,
    ]);
    if (!commit) return;
    if (commit.code !== 0) {
      await warnOnce("git commit failed", commit.stderr);
    }
  } catch (e: unknown) {
    await warnOnce("unexpected error committing vault", e instanceof Error ? e.message : String(e));
  }
}
