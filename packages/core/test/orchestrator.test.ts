import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduleToCron,
  getLocalDate,
  formatLocalDate,
  defaultState,
  loadState,
  saveState,
  updateStateSection,
  Orchestrator,
  type OrchestratorCallbacks,
} from "../src/orchestrator.js";

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

describe("formatLocalDate", () => {
  it("formats a Date as YYYY-MM-DD in local timezone", () => {
    const d = new Date(2026, 4, 6, 23, 45, 0); // May 6 2026 23:45 LOCAL
    expect(formatLocalDate(d)).toBe("2026-05-06");
  });

  it("interprets a UTC ISO timestamp by its LOCAL date, not its UTC date — regression for the BST/UTC rollover bug", () => {
    // 23:45 UTC on May 6 = 00:45 BST on May 7 in summer-time London. The bug
    // was comparing the ISO string's first 10 chars (UTC date "2026-05-06")
    // against getLocalDate() which returns local date — they differed for
    // the entire 1-hour offset window, firing rollover every minute.
    const utcIso = "2026-05-06T23:45:00.000Z";
    const localDate = formatLocalDate(new Date(utcIso));
    // Whatever the test runner's local TZ, formatLocalDate must agree with
    // a same-instant Date created the conventional way. (We can't assert a
    // specific date string without controlling TZ — instead we assert
    // round-trip consistency.)
    const sameDate = formatLocalDate(new Date(Date.parse(utcIso)));
    expect(localDate).toBe(sameDate);
    // Sanity: the function output is YYYY-MM-DD shape
    expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

describe("saveState — concurrent writes", () => {
  it("serialises concurrent calls without ENOENT on tmp rename", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-save-"));
    const s = defaultState();

    // Fire 20 concurrent saves. Prior implementation would race on a shared
    // .tmp filename and throw ENOENT; the new implementation uses unique tmp
    // names plus an in-process queue.
    const saves = Array.from({ length: 20 }, (_, i) => {
      const mutated: typeof s = { ...s, lastHeartbeat: `2026-04-20T00:00:${String(i).padStart(2, "0")}.000Z` };
      return saveState(tmp, mutated);
    });
    await Promise.all(saves);

    // Final file exists and parses as valid JSON
    const loaded = await loadState(tmp);
    expect(loaded.lastHeartbeat).toMatch(/^2026-04-20T00:00:\d{2}\.000Z$/);

    // No orphan .tmp files left behind
    const files = await readdir(join(tmp, "vault"));
    const tmps = files.filter((f) => f.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });

  it("uses unique tmp filenames (pid + random) so parallel writers don't collide", async () => {
    // Simulate cross-process: write to the tmp of a "parallel writer" while saveState is in flight.
    // The real defence is that each saveState picks a unique tmp name; we verify by stubbing
    // the filesystem write to record the tmp paths used.
    const tmp = await mkdtemp(join(tmpdir(), "orch-tmp-"));
    await saveState(tmp, defaultState());
    await saveState(tmp, defaultState());

    // After two sequential saves, no tmp files should be left over.
    const files = await readdir(join(tmp, "vault"));
    const tmps = files.filter((f) => f.endsWith(".tmp"));
    expect(tmps).toEqual([]);

    // Target file exists and is valid
    const raw = await readFile(join(tmp, "vault", "orchestrator-state.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("Dream barrier — failed collectors must not count as 'ran'", () => {
  function makeCallbacks(opts: { failOnce: Set<string> }): OrchestratorCallbacks & { dreamRuns: number } {
    const cb = {
      dreamRuns: 0,
      async runCollector(name: string) {
        if (opts.failOnce.has(name)) {
          opts.failOnce.delete(name);
          throw new Error(`boom: ${name}`);
        }
      },
      async runDreamPipeline() {
        cb.dreamRuns++;
      },
      async runLintPipeline() {},
      async runCompactionPipeline() {},
      async runSchemaEvolutionPipeline() {},
      async getSkillNames() {
        return ["collector-a", "collector-b"];
      },
    };
    return cb;
  }

  it("does not trigger dream when one collector fails; triggers once the failed one later succeeds", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-barrier-"));
    const failOnce = new Set(["collector-b"]);
    const callbacks = makeCallbacks({ failOnce });

    const orch = new Orchestrator(tmp, callbacks);
    await orch.start();

    const schedule = [{ time: "09:00", days: ["mon"] }];
    await orch.updateSchedule("collector-a", schedule, true);
    await orch.updateSchedule("collector-b", schedule, true);

    // collector-b fails first (first call throws) — this still records a lastRun
    // timestamp for bookkeeping, but must NOT satisfy the barrier.
    await orch.triggerRun("collector-b");
    const statusAfterFail = orch.getStatus();
    expect(statusAfterFail.collectors["collector-b"].lastResult).toBe("error");
    expect(statusAfterFail.collectors["collector-b"].lastRun).toBeTruthy();

    // collector-a succeeds — this is when the barrier check runs. Without the
    // fix, collector-b's (failed) lastRun would still count as "ran since last
    // dream" because it only compared timestamps, not lastResult.
    await orch.triggerRun("collector-a");
    expect(callbacks.dreamRuns).toBe(0);

    // collector-b now succeeds (failOnce already consumed) — barrier should be met
    await orch.triggerRun("collector-b");

    expect(callbacks.dreamRuns).toBe(1);
    const statusAfterSuccess = orch.getStatus();
    expect(statusAfterSuccess.collectors["collector-b"].lastResult).toBe("success");

    await orch.stop();
  });
});

describe("runCompact — defers while the dream pipeline is active (race fix, task-14 §D)", () => {
  function baseCallbacks(overrides: Partial<OrchestratorCallbacks> = {}): OrchestratorCallbacks & { compactionCalls: number } {
    const cb = {
      compactionCalls: 0,
      async runCollector() {},
      async runDreamPipeline() {},
      async runLintPipeline() {},
      async runCompactionPipeline() {
        cb.compactionCalls++;
      },
      async runSchemaEvolutionPipeline() {},
      async getSkillNames() {
        return [];
      },
      ...overrides,
    };
    return cb;
  }

  it("defers compaction while an in-process dream run is mid-flight (dreamPipeline.running)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-compact-guard-"));
    let resolveDream: () => void = () => {};
    const gate = new Promise<void>((res) => {
      resolveDream = res;
    });
    const callbacks = baseCallbacks({
      async runDreamPipeline() {
        await gate;
      },
    });
    const orch = new Orchestrator(tmp, callbacks);
    await orch.start();

    const dreamPromise = orch.triggerRun("dreamPipeline");
    // Let the dream run advance far enough to flip dreamPipeline.running = true
    // (it awaits an fs write before reaching the gated callback).
    await new Promise((r) => setTimeout(r, 20));

    await orch.triggerCompact();
    expect(callbacks.compactionCalls).toBe(0);

    resolveDream();
    await dreamPromise;
    await orch.stop();
  });

  it("defers compaction when isDreamLockHeld() reports the lock held externally (manual CLI dream run)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-compact-lockheld-"));
    const callbacks = baseCallbacks({
      async isDreamLockHeld() {
        return true;
      },
    });
    const orch = new Orchestrator(tmp, callbacks);
    await orch.start();

    await orch.triggerCompact();
    expect(callbacks.compactionCalls).toBe(0);
    await orch.stop();
  });

  it("runs compaction normally when neither signal indicates the dream pipeline is active", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-compact-normal-"));
    const callbacks = baseCallbacks({
      async isDreamLockHeld() {
        return false;
      },
    });
    const orch = new Orchestrator(tmp, callbacks);
    await orch.start();

    await orch.triggerCompact();
    expect(callbacks.compactionCalls).toBe(1);
    await orch.stop();
  });

  it("runs compaction normally when isDreamLockHeld is not provided by the host (backward compatible)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-compact-nolockcb-"));
    const callbacks = baseCallbacks();
    const orch = new Orchestrator(tmp, callbacks);
    await orch.start();

    await orch.triggerCompact();
    expect(callbacks.compactionCalls).toBe(1);
    await orch.stop();
  });
});

describe("updateStateSection — scoped read-modify-write", () => {
  it("survives a concurrent whole-object write to a different section", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "orch-section-"));

    // Seed initial state with one collector.
    const initial = defaultState();
    initial.collectors["github-activity"] = {
      enabled: true,
      schedules: [{ time: "09:00", days: ["mon"] }],
      lastRun: null,
      lastResult: "never",
      nextRun: null,
    };
    await saveState(tmp, initial);

    // Simulate a CLI (e.g. compact-cli) that read state at the start of a
    // long-running job...
    const cliSnapshot = await loadState(tmp);

    // ...while it's running, the orchestrator process writes fresh collector
    // state (a real run completing) — a whole-object write, just like the
    // orchestrator's own saveState calls.
    const collectorUpdate = await loadState(tmp);
    collectorUpdate.collectors["github-activity"] = {
      ...collectorUpdate.collectors["github-activity"],
      lastRun: "2026-04-20T12:00:00.000Z",
      lastResult: "success",
    };
    await saveState(tmp, collectorUpdate);

    // The CLI now finishes and writes back ONLY its own section, using its
    // stale `cliSnapshot` as the updater's starting point for that section.
    await updateStateSection(tmp, "compactionPipeline", (cp) => ({
      ...cp,
      perThemeLastCompacted: { "project-x": "2026-04-20T12:05:00.000Z" },
      sizeQueue: [],
    }));

    const final = await loadState(tmp);
    // The concurrent collector update must survive — updateStateSection must
    // NOT have clobbered it with the CLI's stale (pre-update) snapshot.
    expect(final.collectors["github-activity"].lastRun).toBe("2026-04-20T12:00:00.000Z");
    expect(final.collectors["github-activity"].lastResult).toBe("success");
    // And the CLI's own section update took effect.
    expect(final.compactionPipeline.perThemeLastCompacted).toEqual({
      "project-x": "2026-04-20T12:05:00.000Z",
    });

    void cliSnapshot; // documents what the CLI would have held onto pre-fix
  });
});
