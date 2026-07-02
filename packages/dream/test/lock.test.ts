import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Vault } from "@openpulse/core";
import { acquireDreamLock } from "../src/lock.js";

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
});
