import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { handleSubmitUpdate } from "../src/tools/submit-update.js";

describe("submit_update tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-submit-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writes entry to hot log with source field", async () => {
    const result = await handleSubmitUpdate(vault, {
      content: "Deploy completed successfully",
      source: "slack-bot",
      theme: "infrastructure",
    });
    expect(result.content[0].text).toContain("Recorded");
    const today = new Date().toISOString().slice(0, 10);
    const log = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(log).toContain("Deploy completed successfully");
    expect(log).toContain("slack-bot");
    expect(log).toContain("infrastructure");
  });

  it("works without theme", async () => {
    const result = await handleSubmitUpdate(vault, {
      content: "Quick status update",
      source: "teams-bot",
    });
    expect(result.content[0].text).toContain("Recorded");
  });
});
