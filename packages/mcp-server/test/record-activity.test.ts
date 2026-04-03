import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { handleRecordActivity } from "../src/tools/record-activity.js";

describe("record_activity tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("records activity and returns confirmation", async () => {
    const result = await handleRecordActivity(vault, {
      log: "Refactored login page",
      theme: "project-auth",
    });
    expect(result.content[0].text).toContain("Recorded");
    const today = new Date().toISOString().slice(0, 10);
    const content = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(content).toContain("Refactored login page");
    expect(content).toContain("project-auth");
  });

  it("works without a theme", async () => {
    const result = await handleRecordActivity(vault, { log: "Fixed a bug" });
    expect(result.content[0].text).toContain("Recorded");
  });
});
