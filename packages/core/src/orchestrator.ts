/**
 * Orchestrator — cron-based scheduler for skills (collectors) and the Dream Pipeline.
 *
 * Responsibilities:
 *   - Persist state to vault/orchestrator-state.json
 *   - Schedule each collector via croner
 *   - After all enabled collectors finish today, optionally auto-trigger Dream
 *   - Heartbeat every 60 s: detect date rollover, persist state
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import { vaultLog } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Schedule {
  time: string;   // "HH:MM"  24-hour
  days: string[]; // e.g. ["mon","tue","wed","thu","fri"]
}

export interface CollectorState {
  enabled: boolean;
  schedules: Schedule[];
  lastRun: string | null;   // ISO 8601
  lastResult: "success" | "error" | "never";
  lastError?: string;
  nextRun: string | null;   // ISO 8601
}

export interface DreamPipelineState {
  autoTrigger: boolean;
  lastRun: string | null;   // ISO 8601
  lastResult: "success" | "error" | "never";
  lastError?: string;
  collectorsCompletedToday: string[]; // skill names
}

export interface OrchestratorState {
  lastHeartbeat: string | null; // ISO 8601
  collectors: Record<string, CollectorState>;
  dreamPipeline: DreamPipelineState;
}

export interface OrchestratorCallbacks {
  /** Run a named skill/collector. Resolves when done. */
  runCollector(skillName: string): Promise<void>;
  /** Run the Dream Pipeline. Resolves when done. */
  runDreamPipeline(): Promise<void>;
  /** Return currently known skill names. */
  getSkillNames(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const COLLECTOR_TIMEOUT_MS = 2 * 60 * 1000;   // 2 minutes
const DREAM_TIMEOUT_MS     = 5 * 60 * 1000;   // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns today's date as YYYY-MM-DD in local time. */
export function getLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Convert a Schedule to a 5-field cron expression.
 * If all 7 days are present the day field is "*".
 */
export function scheduleToCron(schedule: Schedule): string {
  const [hh, mm] = schedule.time.split(":");
  const minutePart = mm.padStart(2, "0");
  const hourPart   = hh.padStart(2, "0");

  const allDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const hasAll  = allDays.every((d) => schedule.days.includes(d));

  const dayPart = hasAll
    ? "*"
    : schedule.days
        .map((d) => DAY_MAP[d])
        .sort((a, b) => a - b)
        .join(",");

  return `${minutePart} ${hourPart} * * ${dayPart}`;
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

/** Returns a fresh default OrchestratorState. */
export function defaultState(): OrchestratorState {
  return {
    lastHeartbeat: null,
    collectors: {},
    dreamPipeline: {
      autoTrigger: true,
      lastRun: null,
      lastResult: "never",
      collectorsCompletedToday: [],
    },
  };
}

function statePath(vaultRoot: string): string {
  return join(vaultRoot, "vault", "orchestrator-state.json");
}

/** Read state from disk, falling back to defaultState() on any error. */
export async function loadState(vaultRoot: string): Promise<OrchestratorState> {
  try {
    const raw = await readFile(statePath(vaultRoot), "utf-8");
    return JSON.parse(raw) as OrchestratorState;
  } catch {
    return defaultState();
  }
}

/**
 * Atomically write state: write to .tmp → rename old to .prev → rename .tmp to current.
 */
export async function saveState(vaultRoot: string, state: OrchestratorState): Promise<void> {
  const dir  = join(vaultRoot, "vault");
  const file = statePath(vaultRoot);
  const tmp  = file + ".tmp";
  const prev = file + ".prev";

  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");

  // Move current → .prev (ignore if current doesn't exist)
  try {
    await rename(file, prev);
  } catch {
    // file didn't exist yet — that's fine
  }

  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class Orchestrator {
  private vaultRoot: string;
  private callbacks: OrchestratorCallbacks;
  private state: OrchestratorState;
  private jobs: Map<string, Cron[]> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(vaultRoot: string, callbacks: OrchestratorCallbacks) {
    this.vaultRoot = vaultRoot;
    this.callbacks = callbacks;
    this.state = defaultState();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    this.state = await loadState(this.vaultRoot);
    await vaultLog("info", "[orchestrator] Starting");

    // Validate: remove collectors whose skills no longer exist
    const knownSkills = await this.callbacks.getSkillNames();
    const knownSet = new Set(knownSkills);
    for (const name of Object.keys(this.state.collectors)) {
      if (!knownSet.has(name)) {
        await vaultLog("info", `[orchestrator] Removing stale collector: ${name}`);
        delete this.state.collectors[name];
      }
    }

    // Check for missed runs since lastRun
    await this.checkMissedRuns();

    // Create croner jobs for all enabled collectors
    for (const [name, collector] of Object.entries(this.state.collectors)) {
      if (collector.enabled) {
        this.createJobsForCollector(name, collector);
      }
    }

    // 60-second heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) =>
        vaultLog("error", "[orchestrator] Heartbeat error", String(err))
      );
    }, 60_000);

    this.running = true;
    await vaultLog("info", "[orchestrator] Started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.stopAllJobs();

    this.state.lastHeartbeat = new Date().toISOString();
    await saveState(this.vaultRoot, this.state);
    this.running = false;
    await vaultLog("info", "[orchestrator] Stopped");
  }

  getStatus(): OrchestratorState {
    return JSON.parse(JSON.stringify(this.state)) as OrchestratorState;
  }

  isRunning(): boolean {
    return this.running;
  }

  async updateSchedule(
    skill: string,
    schedules: Schedule[],
    enabled: boolean
  ): Promise<void> {
    const existing = this.state.collectors[skill];
    this.state.collectors[skill] = {
      enabled,
      schedules,
      lastRun: existing?.lastRun ?? null,
      lastResult: existing?.lastResult ?? "never",
      lastError: existing?.lastError,
      nextRun: null,
    };

    // Recreate jobs
    this.stopJobsFor(skill);
    if (enabled) {
      this.createJobsForCollector(skill, this.state.collectors[skill]);
    }

    await saveState(this.vaultRoot, this.state);
    await vaultLog("info", `[orchestrator] Updated schedule for ${skill}`);
  }

  async toggleSchedule(target: string, enabled: boolean): Promise<void> {
    if (target === "dreamPipeline") {
      this.state.dreamPipeline.autoTrigger = enabled;
    } else {
      const collector = this.state.collectors[target];
      if (!collector) {
        throw new Error(`Unknown collector: ${target}`);
      }
      collector.enabled = enabled;

      if (enabled) {
        this.createJobsForCollector(target, collector);
      } else {
        this.stopJobsFor(target);
        collector.nextRun = null;
      }
    }

    await saveState(this.vaultRoot, this.state);
    await vaultLog("info", `[orchestrator] Toggled ${target} → ${enabled}`);
  }

  async triggerRun(target: string): Promise<string> {
    if (target === "dreamPipeline") {
      await this.runDream();
      return "Dream Pipeline triggered";
    }

    const collector = this.state.collectors[target];
    if (!collector) {
      throw new Error(`Unknown collector: ${target}`);
    }

    await this.runCollector(target);
    return `Collector ${target} triggered`;
  }

  // -------------------------------------------------------------------------
  // Internal: job management
  // -------------------------------------------------------------------------

  private createJobsForCollector(name: string, collector: CollectorState): void {
    const cronList: Cron[] = [];

    for (const schedule of collector.schedules) {
      const cronExpr = scheduleToCron(schedule);
      try {
        const job = new Cron(cronExpr, { timezone: "local" }, async () => {
          await this.runCollector(name);
        });
        cronList.push(job);
      } catch (err) {
        vaultLog("error", `[orchestrator] Bad cron for ${name}: ${cronExpr}`, String(err)).catch(() => {});
      }
    }

    if (cronList.length > 0) {
      this.jobs.set(name, cronList);
      // Update nextRun from first job
      this.updateNextRun(name);
    }
  }

  private stopJobsFor(name: string): void {
    const list = this.jobs.get(name);
    if (list) {
      for (const job of list) {
        job.stop();
      }
      this.jobs.delete(name);
    }
  }

  private stopAllJobs(): void {
    for (const [name] of this.jobs) {
      this.stopJobsFor(name);
    }
  }

  private updateNextRun(name: string): void {
    const list = this.jobs.get(name);
    const collector = this.state.collectors[name];
    if (!list || !collector) return;

    // Pick earliest next run across all jobs for this collector
    let earliest: Date | null = null;
    for (const job of list) {
      const next = job.nextRun();
      if (next && (!earliest || next < earliest)) {
        earliest = next;
      }
    }
    collector.nextRun = earliest ? earliest.toISOString() : null;
  }

  // -------------------------------------------------------------------------
  // Internal: run logic
  // -------------------------------------------------------------------------

  private async runCollector(name: string): Promise<void> {
    const collector = this.state.collectors[name];
    if (!collector) return;

    await vaultLog("info", `[orchestrator] Running collector: ${name}`);
    const startedAt = new Date().toISOString();

    // Timeout warning (don't kill)
    const warningTimer = setTimeout(() => {
      vaultLog(
        "warn",
        `[orchestrator] Collector ${name} has been running > ${COLLECTOR_TIMEOUT_MS / 1000}s`
      ).catch(() => {});
    }, COLLECTOR_TIMEOUT_MS);

    try {
      await this.callbacks.runCollector(name);

      collector.lastRun    = startedAt;
      collector.lastResult = "success";
      delete collector.lastError;
      this.updateNextRun(name);

      await vaultLog("info", `[orchestrator] Collector ${name} succeeded`);

      // Barrier check
      await this.recordCollectorCompleted(name);
    } catch (err) {
      collector.lastRun    = startedAt;
      collector.lastResult = "error";
      collector.lastError  = String(err);
      this.updateNextRun(name);
      await vaultLog("error", `[orchestrator] Collector ${name} failed`, String(err));
    } finally {
      clearTimeout(warningTimer);
      await saveState(this.vaultRoot, this.state);
    }
  }

  private async recordCollectorCompleted(name: string): Promise<void> {
    const dp = this.state.dreamPipeline;
    if (!dp.collectorsCompletedToday.includes(name)) {
      dp.collectorsCompletedToday.push(name);
    }

    // Check barrier: all enabled collectors done today?
    if (!dp.autoTrigger) return;

    const today = getLocalDate();
    if (dp.lastRun && dp.lastRun.startsWith(today)) {
      // Dream already ran today
      return;
    }

    const enabledCollectors = Object.entries(this.state.collectors)
      .filter(([, c]) => c.enabled)
      .map(([n]) => n);

    const allDone = enabledCollectors.every((n) =>
      dp.collectorsCompletedToday.includes(n)
    );

    if (allDone && enabledCollectors.length > 0) {
      await vaultLog("info", "[orchestrator] Barrier met — triggering Dream Pipeline");
      await this.runDream();
    }
  }

  private async runDream(): Promise<void> {
    const dp = this.state.dreamPipeline;
    const startedAt = new Date().toISOString();

    await vaultLog("info", "[orchestrator] Running Dream Pipeline");

    const warningTimer = setTimeout(() => {
      vaultLog(
        "warn",
        `[orchestrator] Dream Pipeline has been running > ${DREAM_TIMEOUT_MS / 1000}s`
      ).catch(() => {});
    }, DREAM_TIMEOUT_MS);

    try {
      await this.callbacks.runDreamPipeline();

      dp.lastRun    = startedAt;
      dp.lastResult = "success";
      delete dp.lastError;
      dp.collectorsCompletedToday = [];

      await vaultLog("info", "[orchestrator] Dream Pipeline succeeded");
    } catch (err) {
      dp.lastRun    = startedAt;
      dp.lastResult = "error";
      dp.lastError  = String(err);
      dp.collectorsCompletedToday = [];

      await vaultLog("error", "[orchestrator] Dream Pipeline failed", String(err));
    } finally {
      clearTimeout(warningTimer);
      await saveState(this.vaultRoot, this.state);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: heartbeat & missed-run detection
  // -------------------------------------------------------------------------

  private async heartbeat(): Promise<void> {
    const prevDate = this.state.lastHeartbeat
      ? this.state.lastHeartbeat.slice(0, 10)
      : null;
    const today = getLocalDate();

    if (prevDate && prevDate !== today) {
      // Date rolled over — reset collectorsCompletedToday
      await vaultLog("info", "[orchestrator] Date rollover detected, resetting daily state");
      this.state.dreamPipeline.collectorsCompletedToday = [];
    }

    this.state.lastHeartbeat = new Date().toISOString();
    await saveState(this.vaultRoot, this.state);
  }

  private async checkMissedRuns(): Promise<void> {
    const now = new Date();

    for (const [name, collector] of Object.entries(this.state.collectors)) {
      if (!collector.enabled || collector.schedules.length === 0) continue;

      for (const schedule of collector.schedules) {
        const cronExpr = scheduleToCron(schedule);
        try {
          const job = new Cron(cronExpr, { timezone: "local" });
          const prev = job.previousRun();
          job.stop();

          if (!prev) continue;

          const lastRun = collector.lastRun ? new Date(collector.lastRun) : null;

          if (!lastRun || prev > lastRun) {
            await vaultLog(
              "info",
              `[orchestrator] Missed run detected for ${name} at ${prev.toISOString()}, running now`
            );
            // Run async — don't await here so start() returns quickly
            this.runCollector(name).catch((err) =>
              vaultLog("error", `[orchestrator] Missed-run for ${name} failed`, String(err))
            );
            break; // one catch-up run per collector is enough
          }
        } catch (err) {
          await vaultLog("error", `[orchestrator] checkMissedRuns error for ${name}`, String(err));
        }
      }
    }
  }
}
