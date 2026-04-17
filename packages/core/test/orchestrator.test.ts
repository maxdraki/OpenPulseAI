import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleToCron, getLocalDate, defaultState, loadState } from "../src/orchestrator.js";

describe("scheduleToCron", () => {
  it("converts weekday schedule to cron", () => {
    expect(scheduleToCron({ time: "19:00", days: ["mon", "tue", "wed", "thu", "fri"] }))
      .toBe("00 19 * * 1,2,3,4,5");
  });

  it("converts weekend schedule to cron", () => {
    expect(scheduleToCron({ time: "22:00", days: ["sat", "sun"] }))
      .toBe("00 22 * * 0,6");
  });

  it("converts every day to * cron", () => {
    expect(scheduleToCron({ time: "08:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }))
      .toBe("00 08 * * *");
  });

  it("handles single day", () => {
    expect(scheduleToCron({ time: "09:30", days: ["mon"] }))
      .toBe("30 09 * * 1");
  });
});

describe("getLocalDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const date = getLocalDate();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("defaultState", () => {
  it("returns valid default state", () => {
    const state = defaultState();
    expect(state.collectors).toEqual({});
    expect(state.dreamPipeline.autoTrigger).toBe(true);
    expect(state.dreamPipeline.collectorsCompletedToday).toEqual([]);
  });
});

describe("defaultState — new pipelines", () => {
  it("includes compactionPipeline with empty sizeQueue and per-theme map", () => {
    const s = defaultState();
    expect(s.compactionPipeline).toBeDefined();
    expect(s.compactionPipeline.running).toBe(false);
    expect(s.compactionPipeline.sizeQueue).toEqual([]);
    expect(s.compactionPipeline.perThemeLastCompacted).toEqual({});
    expect(s.compactionPipeline.schedule).toEqual({ time: "04:00", days: ["sun","mon","tue","wed","thu","fri","sat"] });
  });

  it("includes schemaEvolutionPipeline with daily schedule (gating is in the CLI)", () => {
    const s = defaultState();
    expect(s.schemaEvolutionPipeline).toBeDefined();
    expect(s.schemaEvolutionPipeline.running).toBe(false);
    expect(s.schemaEvolutionPipeline.schedule).toEqual({ time: "05:00", days: ["sun","mon","tue","wed","thu","fri","sat"] });
  });
});

describe("loadState — migration", () => {
  it("adds compactionPipeline and schemaEvolutionPipeline when missing from persisted state", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-"));
    const vaultDir = join(tmp, "vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(
      join(vaultDir, "orchestrator-state.json"),
      JSON.stringify({
        lastHeartbeat: null,
        collectors: {},
        dreamPipeline: { autoTrigger: true, running: false, lastRun: null, lastResult: "never", collectorsCompletedToday: [] },
        lintPipeline: { running: false, lastRun: null, lastResult: "never", schedule: { time: "20:00", days: ["sun"] } },
      }),
      "utf-8"
    );
    const state = await loadState(tmp);
    expect(state.compactionPipeline).toBeDefined();
    expect(state.schemaEvolutionPipeline).toBeDefined();
    expect(state.compactionPipeline.sizeQueue).toEqual([]);
  });
});
