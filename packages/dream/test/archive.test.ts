import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { archiveProcessedHotFiles } from "../src/archive.js";

describe("archiveProcessedHotFiles", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-archive-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("archives all hot files including today", async () => {
    await writeFile(vault.dailyLogPath("2026-04-02"), "# Old log", "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(vault.dailyLogPath(today), "# Today log", "utf-8");

    await archiveProcessedHotFiles(vault);

    // Both files should be archived
    await expect(stat(vault.dailyLogPath("2026-04-02"))).rejects.toThrow();
    await expect(stat(vault.dailyLogPath(today))).rejects.toThrow();
    const archived = await readFile(join(vault.coldDir, "2026-04", "2026-04-02.md"), "utf-8");
    expect(archived).toBe("# Old log");
    const todayMonth = today.slice(0, 7);
    const archivedToday = await readFile(join(vault.coldDir, todayMonth, `${today}.md`), "utf-8");
    expect(archivedToday).toBe("# Today log");
  });
});
