import { readFile, writeFile, unlink, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Vault, vaultLog } from "@openpulse/core";

/**
 * Vault-level Dream Pipeline lock. The orchestrator's `dp.running` flag is
 * in-memory only, so a manually-invoked `openpulse-dream` CLI run can race an
 * orchestrator-triggered run — both would read the same hot files, classify
 * and synthesize independently, and produce duplicate pending updates. This
 * lockfile is a cross-process guard acquired by the shared pipeline entry
 * point (used by both the CLI and the orchestrator).
 */

const STALE_LOCK_MS = 30 * 60 * 1000; // 30 minutes

interface LockInfo {
  pid: number;
  startedAt: string; // ISO 8601
}

function lockPath(vault: Vault): string {
  return join(vault.root, "vault", ".dream.lock");
}

/** True if `pid` refers to a live process this user can see. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive from our point of view. Anything else (ESRCH, etc.) means dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the Dream Pipeline lock, stealing a stale/dead-owner lock if found.
 * Throws if a live, fresh (< 30 min old) lock is already held by another process.
 * Returns a release function — callers MUST call it in a `finally` block.
 */
export async function acquireDreamLock(vault: Vault): Promise<() => Promise<void>> {
  const file = lockPath(vault);

  let existing: LockInfo | null = null;
  try {
    const raw = await readFile(file, "utf-8");
    existing = JSON.parse(raw) as LockInfo;
  } catch {
    // No lock file (or unreadable/corrupt) — treat as no lock held.
  }

  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.startedAt);
    const fresh = Number.isFinite(ageMs) && ageMs < STALE_LOCK_MS;
    const alive = isPidAlive(existing.pid);

    if (alive && fresh) {
      throw new Error(
        `Dream pipeline already running (pid ${existing.pid}, started ${existing.startedAt}). Refusing to start a second run.`
      );
    }

    await vaultLog(
      "warn",
      "[dream] Stealing stale/dead dream lock",
      `previous holder pid=${existing.pid} startedAt=${existing.startedAt} alive=${alive} ageMs=${ageMs}`
    );
  }

  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2), "utf-8");
  try {
    await rename(tmp, file);
  } catch (err) {
    try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }

  return async () => {
    try {
      await unlink(file);
    } catch {
      // Already gone — nothing to release.
    }
  };
}
