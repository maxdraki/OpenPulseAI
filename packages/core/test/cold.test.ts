import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../src/vault.js";
import { archiveHotFile } from "../src/cold.js";

describe("Cold Layer", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-cold-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("moves a hot file to cold storage under YYYY-MM/ directory", async () => {
    const hotPath = vault.dailyLogPath("2026-03-15");
    await writeFile(hotPath, "# Log content", "utf-8");

    await archiveHotFile(vault, "2026-03-15");

    // Original should be gone
    await expect(stat(hotPath)).rejects.toThrow();

    // Should exist in cold
    const coldPath = join(vault.coldDir, "2026-03", "2026-03-15.md");
    const content = await readFile(coldPath, "utf-8");
    expect(content).toBe("# Log content");
  });
});
