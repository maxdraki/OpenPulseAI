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

// How often the running pipeline refreshes its lockfile's `refreshedAt` (see
// `LockInfo`) while it holds the lock. Long runs (LLM retries, slow local
// Ollama models) can easily exceed `STALE_LOCK_MS` — without a heartbeat, a
// perfectly healthy in-progress run would look stale to any other process
// checking the lock and get its lock stolen out from under it (I1). Well
// under `STALE_LOCK_MS` so a single missed tick (e.g. a slow event loop)
// doesn't flip the lock stale.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Bounded retry for the steal loop: each iteration either wins an exclusive
// create or discovers a live/fresh lock and throws. A tight bound just
// guards against pathological flapping between two stealers; in practice one
// of them wins within 1-2 iterations.
const MAX_ACQUIRE_ATTEMPTS = 10;

interface LockInfo {
  pid: number;
  startedAt: string; // ISO 8601
  /** ISO 8601 — last heartbeat write by the current holder, if any. Staleness
   *  is judged against max(startedAt, refreshedAt) so a long-but-healthy run
   *  never looks stale as long as its heartbeat keeps landing (I1). */
  refreshedAt?: string;
}

/** Milliseconds since the more recent of `startedAt`/`refreshedAt`. */
function lockAgeMs(info: LockInfo): number {
  const started = Date.parse(info.startedAt);
  const refreshed = info.refreshedAt ? Date.parse(info.refreshedAt) : NaN;
  const latest = Number.isFinite(refreshed) && refreshed > started ? refreshed : started;
  return Date.now() - latest;
}

/** Best-effort heartbeat write — if the lockfile is gone (e.g. another
 *  process stole it, or we already released) there's nothing to refresh. */
async function refreshLock(file: string, pid: number, startedAt: string): Promise<void> {
  try {
    const info: LockInfo = { pid, startedAt, refreshedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(info, null, 2), "utf-8");
  } catch {
    // Best-effort — see docstring above.
  }
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

      // Start the heartbeat: refresh `refreshedAt` on an interval so a long
      // run never looks stale to another process checking the lock (I1).
      // `unref()` so this timer alone can never keep the Node process alive
      // (it must not block a clean exit if something else terminates the
      // pipeline outside the normal finally/release path).
      const timer = setInterval(() => {
        void refreshLock(file, info.pid, info.startedAt);
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref();

      return async () => {
        clearInterval(timer);
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
      const ageMs = lockAgeMs(existing);
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
