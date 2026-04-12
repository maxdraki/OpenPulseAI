import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { ClassificationResult, LlmProvider } from "@openpulse/core";
import { synthesizeToPending } from "../src/synthesize.js";

function mockProvider(responseText: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(responseText) };
}

describe("synthesizeToPending", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-synth-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates pending update files", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Refactored login page" },
        themes: ["project-auth"],
        confidence: 0.95,
      },
    ];

    const provider = mockProvider("## Current Status\n\nLogin page refactored.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    const pendingFiles = await readdir(vault.pendingDir);
    expect(pendingFiles.length).toBe(1);
    expect(pendingFiles[0]).toMatch(/\.json$/);
  });

  it("includes existing warm content in LLM prompt", async () => {
    await writeTheme(vault, "project-auth", "OAuth integration pending.");

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T14:00:00Z", log: "OAuth completed" },
        themes: ["project-auth"],
        confidence: 0.9,
      },
    ];

    const provider = mockProvider("## Current Status\n\nOAuth completed.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("OAuth integration pending"),
      })
    );
  });

  it("groups entries by theme and creates one pending update per theme", async () => {
    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Login page refactored" },
        themes: ["project-auth", "frontend"],
        confidence: 0.95,
      },
      {
        entry: { timestamp: "2026-04-03T11:00:00Z", log: "Added unit tests" },
        themes: ["project-auth"],
        confidence: 0.9,
      },
    ];

    const provider = mockProvider("## Current Status\n\nWork done.");
    const results = await synthesizeToPending(vault, classified, provider, "test-model");

    // Should create two pending updates: one for project-auth, one for frontend
    expect(results.length).toBe(2);
    const themeNames = results.map((r) => r.theme).sort();
    expect(themeNames).toEqual(["frontend", "project-auth"]);

    // All updates share the same batchId
    expect(results[0].batchId).toBeDefined();
    expect(results[0].batchId).toBe(results[1].batchId);
  });

  it("includes cross-reference instruction in LLM prompt", async () => {
    await writeTheme(vault, "other-theme", "Some other theme content.");

    const classified: ClassificationResult[] = [
      {
        entry: { timestamp: "2026-04-03T10:00:00Z", log: "Work on project-auth" },
        themes: ["project-auth"],
        confidence: 0.95,
      },
    ];

    const provider = mockProvider("## Current Status\n\nDone.");
    await synthesizeToPending(vault, classified, provider, "test-model");

    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Other themes in the wiki"),
      })
    );
  });
});
