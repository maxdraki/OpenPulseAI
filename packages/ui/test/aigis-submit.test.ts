import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../core/dist/index.js";
import type { AigisConfig } from "../../core/dist/index.js";
import {
  buildAigisSubmitArgs,
  appendAigisSubmissionRecord,
  findAigisSubmissionRecord,
  submitAigisRollup,
  resubmitAigisRollup,
  aigisThemeFilePath,
  type AigisSubmissionRecord,
} from "../src/lib/aigis-submit.js";

function baseConfig(overrides: Partial<AigisConfig> = {}): AigisConfig {
  return {
    endpoint: "https://aigis.bio/mcp",
    submitTool: "aigis_submit_journal",
    enabled: true,
    ...overrides,
  };
}

describe("buildAigisSubmitArgs", () => {
  it("maps content + period into the conservative submit payload", () => {
    const args = buildAigisSubmitArgs("## Rollup\nBody", "2026-06-01", "2026-06-07");
    expect(args).toEqual({
      journal: "## Rollup\nBody",
      period_start: "2026-06-01",
      period_end: "2026-06-07",
      source: "openpulse",
    });
  });
});

describe("aigis-submit.ts", () => {
  let tempDir: string;
  let vault: Vault;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-aigis-submit-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("appendAigisSubmissionRecord / findAigisSubmissionRecord", () => {
    it("appends a JSONL line and finds it back by updateId", async () => {
      const record: AigisSubmissionRecord = {
        updateId: "u1",
        theme: "aigis-rollup-2026-06-07",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-07",
        submittedAt: "2026-06-07T00:00:00.000Z",
        ok: true,
        toolName: "aigis_submit_journal",
      };
      await appendAigisSubmissionRecord(vault, record);

      const found = await findAigisSubmissionRecord(vault, "u1");
      expect(found).toEqual(record);

      const raw = await readFile(join(vault.aigisDir, "submissions.jsonl"), "utf-8");
      expect(raw.trim().split("\n")).toHaveLength(1);
    });

    it("returns the LAST matching record when a resubmit appended a new line for the same updateId", async () => {
      await appendAigisSubmissionRecord(vault, {
        updateId: "u2", theme: "t", periodStart: "s", periodEnd: "e",
        submittedAt: "2026-06-07T00:00:00.000Z", ok: false, error: "boom", toolName: "aigis_submit_journal",
      });
      await appendAigisSubmissionRecord(vault, {
        updateId: "u2", theme: "t", periodStart: "s", periodEnd: "e",
        submittedAt: "2026-06-07T01:00:00.000Z", ok: true, toolName: "aigis_submit_journal",
      });

      const found = await findAigisSubmissionRecord(vault, "u2");
      expect(found?.ok).toBe(true);
      expect(found?.submittedAt).toBe("2026-06-07T01:00:00.000Z");
    });

    it("returns undefined when no submissions.jsonl exists yet", async () => {
      const found = await findAigisSubmissionRecord(vault, "does-not-exist");
      expect(found).toBeUndefined();
    });
  });

  describe("submitAigisRollup", () => {
    it("calls the injected tool with the mapped args and records ok:true on success", async () => {
      const callTool = vi.fn().mockResolvedValue({ ok: true, content: "accepted" });
      const outcome = await submitAigisRollup(
        vault, baseConfig(), "u3", "aigis-rollup-a", "## Rollup content", "2026-06-01", "2026-06-07", callTool
      );

      expect(outcome).toEqual({ ok: true });
      expect(callTool).toHaveBeenCalledWith(
        baseConfig(),
        "aigis_submit_journal",
        { journal: "## Rollup content", period_start: "2026-06-01", period_end: "2026-06-07", source: "openpulse" }
      );

      const record = await findAigisSubmissionRecord(vault, "u3");
      expect(record?.ok).toBe(true);
      expect(record?.theme).toBe("aigis-rollup-a");
    });

    it("records ok:false with the error on failure, and never throws", async () => {
      const callTool = vi.fn().mockResolvedValue({ ok: false, error: "Aigis rejected the payload", transportError: false });
      const outcome = await submitAigisRollup(
        vault, baseConfig(), "u4", "aigis-rollup-b", "## Content", "2026-06-01", "2026-06-07", callTool
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBe("Aigis rejected the payload");
      const record = await findAigisSubmissionRecord(vault, "u4");
      expect(record?.ok).toBe(false);
      expect(record?.error).toBe("Aigis rejected the payload");
    });

    it("skips the network call and records a not-connected outcome when config is disabled/absent", async () => {
      const callTool = vi.fn();
      const outcome = await submitAigisRollup(
        vault, undefined, "u5", "aigis-rollup-c", "## Content", "2026-06-01", "2026-06-07", callTool
      );

      expect(outcome).toEqual({ ok: false, error: "skipped: not connected", skipped: true });
      expect(callTool).not.toHaveBeenCalled();
      const record = await findAigisSubmissionRecord(vault, "u5");
      expect(record?.error).toBe("skipped: not connected");
      // Fix round 1 (#2): the JSONL record must be flagged distinctly from a
      // real submission failure so the Settings display doesn't conflate them.
      expect(record?.skipped).toBe(true);
    });

    it("does NOT set skipped on a real (connected) submission failure", async () => {
      const callTool = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
      await submitAigisRollup(vault, baseConfig(), "u6", "aigis-rollup-e", "## Content", "2026-06-01", "2026-06-07", callTool);
      const record = await findAigisSubmissionRecord(vault, "u6");
      expect(record?.skipped).toBeFalsy();
    });

    it("appends a pending record before the outbound call, so a crash mid-call still leaves a resubmittable record (#4)", async () => {
      const seen: Array<AigisSubmissionRecord | undefined> = [];
      const callTool = vi.fn().mockImplementation(async () => {
        // Simulate observing vault state mid-flight, as if the process died
        // right here: a record for this updateId must already exist.
        seen.push(await findAigisSubmissionRecord(vault, "u7"));
        return { ok: true };
      });
      await submitAigisRollup(vault, baseConfig(), "u7", "aigis-rollup-f", "## Content", "2026-06-01", "2026-06-07", callTool);

      expect(seen[0]).toBeDefined();
      expect(seen[0]?.ok).toBe(false);
      expect(seen[0]?.theme).toBe("aigis-rollup-f");

      // And the final record (after the call resolves) reflects the real outcome.
      const final = await findAigisSubmissionRecord(vault, "u7");
      expect(final?.ok).toBe(true);
    });
  });

  describe("resubmitAigisRollup", () => {
    it("returns 404 when no prior submission record exists for the id", async () => {
      const outcome = await resubmitAigisRollup(tempDir, "unknown-id");
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(404);
    });

    it("re-reads the aigis content file and retries, appending a new success record", async () => {
      // Seed a prior failed submission (as approve() would have on first attempt).
      await appendAigisSubmissionRecord(vault, {
        updateId: "retry-1", theme: "aigis-rollup-d", periodStart: "2026-06-01", periodEnd: "2026-06-07",
        submittedAt: "2026-06-07T00:00:00.000Z", ok: false, error: "timed out", toolName: "aigis_submit_journal",
      });
      await writeFile(aigisThemeFilePath(vault, "aigis-rollup-d"), "## Rollup\nRetry content", "utf-8");
      await writeFile(join(tempDir, "config.yaml"), [
        "aigis:",
        "  endpoint: https://aigis.bio/mcp",
        "  authToken: tok",
        "  submitTool: aigis_submit_journal",
        "  enabled: true",
        "",
      ].join("\n"), "utf-8");

      const callTool = vi.fn().mockResolvedValue({ ok: true });
      const outcome = await resubmitAigisRollup(tempDir, "retry-1", callTool);

      expect(outcome.ok).toBe(true);
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "https://aigis.bio/mcp" }),
        "aigis_submit_journal",
        expect.objectContaining({ journal: "## Rollup\nRetry content" })
      );

      const latest = await findAigisSubmissionRecord(vault, "retry-1");
      expect(latest?.ok).toBe(true);
    });

    it("rejects (400) an unsafe theme name in the found record, without touching the filesystem (#3)", async () => {
      await appendAigisSubmissionRecord(vault, {
        updateId: "retry-unsafe", theme: "../../etc/passwd", periodStart: "2026-06-01", periodEnd: "2026-06-07",
        submittedAt: "2026-06-07T00:00:00.000Z", ok: false, error: "timed out", toolName: "aigis_submit_journal",
      });

      const callTool = vi.fn();
      const outcome = await resubmitAigisRollup(tempDir, "retry-unsafe", callTool);

      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(400);
      expect(callTool).not.toHaveBeenCalled();
    });

    it("returns 404 when the record exists but the aigis content file is missing", async () => {
      await appendAigisSubmissionRecord(vault, {
        updateId: "retry-2", theme: "aigis-rollup-missing-file", periodStart: "2026-06-01", periodEnd: "2026-06-07",
        submittedAt: "2026-06-07T00:00:00.000Z", ok: false, error: "skipped: not connected", toolName: "aigis_submit_journal",
      });

      const outcome = await resubmitAigisRollup(tempDir, "retry-2");
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(404);
    });
  });
});
