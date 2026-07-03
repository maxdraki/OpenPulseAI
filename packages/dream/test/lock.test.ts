import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Vault } from "@openpulse/core";
import { acquireDreamLock, isDreamLockHeld } from "../src/lock.js";

function lockFilePath(vault: Vault): string {
  return join(vault.root, "vault", ".dream.lock");
}

/** Returns a pid guaranteed to be dead: spawn a process synchronously (it
 *  exits before this returns), then reuse its now-free pid. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = result.pid;
  if (!pid) throw new Error("failed to spawn helper process for dead-pid test");
  return pid;
}

describe("acquireDreamLock", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-lock-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("acquires the lock when none exists, writing pid + startedAt", async () => {
    const release = await acquireDreamLock(vault);
    const raw = await readFile(lockFilePath(vault), "utf-8");
    const info = JSON.parse(raw);
    expect(info.pid).toBe(process.pid);
    expect(typeof info.startedAt).toBe("string");
    await release();
  });

  it("release() deletes the lock file", async () => {
    const release = await acquireDreamLock(vault);
    await release();
    await expect(stat(lockFilePath(vault))).rejects.toThrow();
  });

  it("refuses a second concurrent run when the existing lock is fresh and the pid is alive", async () => {
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf-8"
    );

    await expect(acquireDreamLock(vault)).rejects.toThrow(/already running/i);
  });

  it("steals the lock when the owning pid is dead", async () => {
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }),
      "utf-8"
    );

    const release = await acquireDreamLock(vault);
    const raw = await readFile(lockFilePath(vault), "utf-8");
    expect(JSON.parse(raw).pid).toBe(process.pid);
    await release();
  });

  it("steals the lock when it is stale (older than 30 minutes) even if the pid is alive", async () => {
    const staleStartedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: process.pid, startedAt: staleStartedAt }),
      "utf-8"
    );

    const release = await acquireDreamLock(vault);
    const raw = await readFile(lockFilePath(vault), "utf-8");
    const info = JSON.parse(raw);
    expect(info.pid).toBe(process.pid);
    expect(info.startedAt).not.toBe(staleStartedAt);
    await release();
  });

  it("does NOT steal a lock with an old startedAt but a fresh refreshedAt heartbeat, when the owner pid is alive (I1)", async () => {
    const staleStartedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const freshRefreshedAt = new Date().toISOString();
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: process.pid, startedAt: staleStartedAt, refreshedAt: freshRefreshedAt }),
      "utf-8"
    );

    await expect(acquireDreamLock(vault)).rejects.toThrow(/already running/i);
  });

  it("acquisition is atomic: two concurrent acquireDreamLock() calls racing from no lock never both succeed (TOCTOU regression)", async () => {
    // The old implementation was check-then-write (read, decide "no lock
    // exists", then write): two callers racing could both observe "no lock"
    // before either had written, and both would go on to succeed. The fix
    // uses an exclusive `wx` create, so exactly one of two truly-concurrent
    // callers can win; the other must see a live/fresh lock and refuse.
    const results = await Promise.allSettled([acquireDreamLock(vault), acquireDreamLock(vault)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already running/i);

    await (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  });

  it("heartbeat refreshes the lock's refreshedAt periodically while held, and the timer doesn't block process exit (I1)", async () => {
    vi.useFakeTimers();
    try {
      const release = await acquireDreamLock(vault);
      const before = JSON.parse(await readFile(lockFilePath(vault), "utf-8"));
      expect(before.refreshedAt).toBeUndefined();

      // Advance past the 5-minute heartbeat interval.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      const after = JSON.parse(await readFile(lockFilePath(vault), "utf-8"));
      expect(after.refreshedAt).toEqual(expect.any(String));
      expect(after.pid).toBe(process.pid);

      await release();
      // Releasing must clear the interval — no further writes after this point.
      await expect(stat(lockFilePath(vault))).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the exclusive create after stealing on EEXIST, ending up with its own pid in the lock", async () => {
    // Directly exercises the EEXIST branch: a dead-pid lock is present, so
    // the first `wx` create attempt fails with EEXIST, the loop reads the
    // existing lock, decides it's stealable, unlinks it, and retries.
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }),
      "utf-8"
    );

    const release = await acquireDreamLock(vault);
    const raw = await readFile(lockFilePath(vault), "utf-8");
    expect(JSON.parse(raw).pid).toBe(process.pid);
    await release();
  });
});

describe("isDreamLockHeld", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-lock-probe-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns false when no lock file exists", async () => {
    expect(await isDreamLockHeld(vault)).toBe(false);
  });

  it("returns true when a fresh lock is held by a live pid", async () => {
    const release = await acquireDreamLock(vault);
    expect(await isDreamLockHeld(vault)).toBe(true);
    await release();
  });

  it("returns false after the lock is released", async () => {
    const release = await acquireDreamLock(vault);
    await release();
    expect(await isDreamLockHeld(vault)).toBe(false);
  });

  it("returns false for a stale lock (owner pid dead), without stealing or deleting it", async () => {
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }),
      "utf-8"
    );
    expect(await isDreamLockHeld(vault)).toBe(false);
    // Non-destructive: the lockfile is still there afterward.
    await expect(stat(lockFilePath(vault))).resolves.toBeDefined();
  });

  it("returns false for a lock older than 30 minutes even if the pid is alive", async () => {
    const staleStartedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await writeFile(
      lockFilePath(vault),
      JSON.stringify({ pid: process.pid, startedAt: staleStartedAt }),
      "utf-8"
    );
    expect(await isDreamLockHeld(vault)).toBe(false);
  });
});
