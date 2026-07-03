import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// Bounded retry for the steal loop: each iteration either wins an exclusive
// create or discovers a live/fresh lock and throws. A tight bound just
// guards against pathological flapping between two stealers; in practice one
// of them wins within 1-2 iterations.
const MAX_ACQUIRE_ATTEMPTS = 10;

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
 *
 * Acquisition is a single atomic exclusive-create (`{ flag: "wx" }`), not a
 * check-then-write: reading the lock first and only then writing it (the
 * previous implementation) is a classic TOCTOU — two processes can both pass
 * the "no lock exists" check before either has written, and both go on to
 * acquire. `wx` fails with EEXIST if the file already exists, so only one
 * concurrent caller can ever win a given create. On EEXIST we read the
 * existing lock, decide whether to steal it (dead pid / stale), and — if so
 * — unlink it and retry the exclusive create. The retry is bounded so two
 * stealers racing each other can't loop forever; the loser of a given
 * iteration will see the winner's fresh, live lock on the next iteration and
 * correctly refuse instead of retrying indefinitely.
 */
export async function acquireDreamLock(vault: Vault): Promise<() => Promise<void>> {
  const file = lockPath(vault);
  await mkdir(dirname(file), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
    try {
      await writeFile(file, JSON.stringify(info, null, 2), { encoding: "utf-8", flag: "wx" });
      return async () => {
        try {
          await unlink(file);
        } catch {
          // Already gone — nothing to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Someone else holds the lock (or held it a moment ago). Read it and
    // decide whether it's stealable.
    let existing: LockInfo | null = null;
    try {
      const raw = await readFile(file, "utf-8");
      existing = JSON.parse(raw) as LockInfo;
    } catch {
      // Unreadable/corrupt, or it vanished between our failed create and this
      // read (the previous holder released it) — either way, nothing to
      // steal; just retry the exclusive create on the next loop iteration.
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

      try {
        await unlink(file);
      } catch {
        // Another stealer already removed it — fine, our next wx create
        // attempt will just race them fairly.
      }
    }
    // Loop and retry the exclusive create.
  }

  throw new Error(
    "Dream pipeline lock: exceeded retry attempts while stealing a stale lock (likely racing another stealer)."
  );
}
