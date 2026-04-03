import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";

describe("Vault", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates vault directory structure on init", async () => {
    const vault = new Vault(tempDir);
    await vault.init();

    const { stat } = await import("node:fs/promises");
    expect((await stat(vault.hotDir)).isDirectory()).toBe(true);
    expect((await stat(vault.ingestDir)).isDirectory()).toBe(true);
    expect((await stat(vault.warmDir)).isDirectory()).toBe(true);
    expect((await stat(vault.pendingDir)).isDirectory()).toBe(true);
    expect((await stat(vault.coldDir)).isDirectory()).toBe(true);
  });

  it("returns correct path helpers", () => {
    const vault = new Vault("/tmp/test-vault");
    expect(vault.hotDir).toBe("/tmp/test-vault/vault/hot");
    expect(vault.ingestDir).toBe("/tmp/test-vault/vault/hot/ingest");
    expect(vault.warmDir).toBe("/tmp/test-vault/vault/warm");
    expect(vault.pendingDir).toBe("/tmp/test-vault/vault/warm/_pending");
    expect(vault.coldDir).toBe("/tmp/test-vault/vault/cold");
  });

  it("dailyLogPath returns date-stamped path", () => {
    const vault = new Vault("/tmp/test-vault");
    const path = vault.dailyLogPath("2026-04-03");
    expect(path).toBe("/tmp/test-vault/vault/hot/2026-04-03.md");
  });

  it("themeFilePath returns warm theme path", () => {
    const vault = new Vault("/tmp/test-vault");
    const path = vault.themeFilePath("project-auth");
    expect(path).toBe("/tmp/test-vault/vault/warm/project-auth.md");
  });

  it("creates sessions directory on init", async () => {
    const vault = new Vault(tempDir);
    await vault.init();
    const { stat } = await import("node:fs/promises");
    expect((await stat(vault.sessionsDir)).isDirectory()).toBe(true);
  });
});
