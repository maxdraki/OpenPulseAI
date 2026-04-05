# Scheduler & Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual skill running with a visual scheduler — users set times and days via pickers, an orchestrator runs collectors on schedule and auto-triggers the dream pipeline when all collectors complete for the day.

**Architecture:** Orchestrator engine in `packages/core` uses `croner` for scheduling and a JSON state file for persistence. The dev server starts the orchestrator on boot and exposes 4 API endpoints. A new Schedule page shows collector cards with time pickers and barrier progress for the dream pipeline.

**Tech Stack:** `croner` (zero-dep cron scheduler), vanilla TS UI, file-based JSON persistence

**Spec:** `docs/superpowers/specs/2026-04-05-scheduler-orchestrator.md`

---

## File Map

### New files

| File | Responsibility |
|---|---|
| `packages/core/src/orchestrator.ts` | Orchestrator engine: croner jobs, barrier logic, state I/O, health checks |
| `packages/core/test/orchestrator.test.ts` | Orchestrator unit tests |
| `packages/ui/src/pages/schedule.ts` | Schedule page UI |

### Modified files

| File | Change |
|---|---|
| `packages/core/src/index.ts` | Export orchestrator types and class |
| `packages/core/package.json` | Add `croner` dependency |
| `packages/ui/src/main.ts` | Add schedule route |
| `packages/ui/index.html` | Add Schedule sidebar nav item |
| `packages/ui/server.ts` | Add 4 orchestrator endpoints, start orchestrator on boot |
| `packages/ui/src/lib/tauri-bridge.ts` | Add 4 orchestrator bridge functions |
| `packages/ui/src/pages/dashboard.ts` | Remove Refresh button |
| `packages/ui/src/pages/skills.ts` | Add "Set up schedule" link after install |
| `packages/ui/src/styles.css` | Schedule page styles |

---

## Task 1: Add croner dependency and orchestrator types

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/orchestrator.ts` (types only initially)

- [ ] **Step 1: Add croner dependency**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
pnpm --filter @openpulse/core add croner
```

- [ ] **Step 2: Create orchestrator.ts with types and state I/O**

Create `packages/core/src/orchestrator.ts` with the core types and state file management:

```typescript
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { vaultLog } from "./logger.js";

// --- Types ---

export interface Schedule {
  time: string;   // "HH:MM" 24-hour format, e.g. "19:00"
  days: string[];  // ["mon","tue","wed","thu","fri","sat","sun"]
}

export interface CollectorState {
  enabled: boolean;
  schedules: Schedule[];
  lastRun: string | null;       // ISO 8601
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  nextRun: string | null;       // ISO 8601
}

export interface DreamPipelineState {
  autoTrigger: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  collectorsCompletedToday: string[];
}

export interface OrchestratorState {
  lastHeartbeat: string;        // ISO 8601
  collectors: Record<string, CollectorState>;
  dreamPipeline: DreamPipelineState;
}

// --- State file I/O ---

const STATE_FILENAME = "orchestrator-state.json";
const STATE_PREV = "orchestrator-state.prev.json";
const STATE_TMP = "orchestrator-state.tmp.json";

function statePath(vaultRoot: string): string {
  return join(vaultRoot, "vault", STATE_FILENAME);
}

export function defaultState(): OrchestratorState {
  return {
    lastHeartbeat: new Date().toISOString(),
    collectors: {},
    dreamPipeline: {
      autoTrigger: true,
      lastRun: null,
      lastResult: "never",
      lastError: null,
      collectorsCompletedToday: [],
    },
  };
}

export async function loadState(vaultRoot: string): Promise<OrchestratorState> {
  try {
    const raw = await readFile(statePath(vaultRoot), "utf-8");
    return JSON.parse(raw);
  } catch {
    await vaultLog("warn", "Orchestrator state file not found, using defaults");
    return defaultState();
  }
}

export async function saveState(vaultRoot: string, state: OrchestratorState): Promise<void> {
  const path = statePath(vaultRoot);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  // Atomic write: write tmp, backup prev, rename tmp to current
  const tmpPath = join(dir, STATE_TMP);
  const prevPath = join(dir, STATE_PREV);

  state.lastHeartbeat = new Date().toISOString();
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");

  try {
    await rename(path, prevPath);
  } catch { /* no previous state file */ }

  await rename(tmpPath, path);
}

// --- Schedule helpers ---

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function scheduleToCron(schedule: Schedule): string {
  const [hour, min] = schedule.time.split(":");
  if (schedule.days.length === 7) {
    return `${min} ${hour} * * *`;
  }
  const cronDays = schedule.days.map((d) => DAY_MAP[d]).sort().join(",");
  return `${min} ${hour} * * ${cronDays}`;
}

export function getLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
```

- [ ] **Step 3: Export from index.ts**

Add to `packages/core/src/index.ts`:

```typescript
export {
  type Schedule,
  type CollectorState as OrchestratorCollectorState,
  type DreamPipelineState,
  type OrchestratorState,
  defaultState,
  loadState,
  saveState,
  scheduleToCron,
  getLocalDate,
} from "./orchestrator.js";
```

Note: exported as `OrchestratorCollectorState` to avoid conflicting with the existing `CollectorState` type in `types.ts`.

- [ ] **Step 4: Build and run tests**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run
```

Expected: All existing tests pass. No new tests yet.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/orchestrator.ts packages/core/src/index.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): add orchestrator types, state I/O, and schedule helpers"
```

---

## Task 2: Orchestrator engine with croner scheduling

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Create: `packages/core/test/orchestrator.test.ts`

- [ ] **Step 1: Write orchestrator tests**

Create `packages/core/test/orchestrator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scheduleToCron, getLocalDate, defaultState } from "../src/orchestrator.js";

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
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run packages/core/test/orchestrator.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Add Orchestrator class to orchestrator.ts**

Append to `packages/core/src/orchestrator.ts`:

```typescript
import { Cron } from "croner";

export interface OrchestratorCallbacks {
  runCollector: (skillName: string) => Promise<{ success: boolean; output: string }>;
  runDreamPipeline: () => Promise<{ success: boolean; output: string }>;
  getSkillNames: () => Promise<string[]>;
}

export class Orchestrator {
  private vaultRoot: string;
  private state: OrchestratorState;
  private jobs: Map<string, Cron[]> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private callbacks: OrchestratorCallbacks;
  private running = false;

  constructor(vaultRoot: string, callbacks: OrchestratorCallbacks) {
    this.vaultRoot = vaultRoot;
    this.state = defaultState();
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.state = await loadState(this.vaultRoot);
    await this.validateState();
    await this.checkMissedRuns();
    this.createAllJobs();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 60_000);
    this.running = true;
    await vaultLog("info", "Orchestrator started", `${Object.keys(this.state.collectors).length} collectors configured`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const jobs of this.jobs.values()) {
      for (const job of jobs) job.stop();
    }
    this.jobs.clear();
    await this.persist();
    await vaultLog("info", "Orchestrator stopped");
  }

  getStatus(): OrchestratorState {
    return { ...this.state };
  }

  isRunning(): boolean {
    return this.running;
  }

  async updateSchedule(skill: string, schedules: Schedule[], enabled: boolean): Promise<void> {
    this.state.collectors[skill] = {
      ...(this.state.collectors[skill] ?? {
        lastRun: null,
        lastResult: "never",
        lastError: null,
        nextRun: null,
      }),
      enabled,
      schedules,
    };
    this.recreateJobsFor(skill);
    await this.persist();
    await vaultLog("info", `Schedule updated: ${skill}`, `${schedules.length} schedule(s), enabled=${enabled}`);
  }

  async toggleSchedule(target: string, enabled: boolean): Promise<void> {
    if (target === "dream") {
      this.state.dreamPipeline.autoTrigger = enabled;
    } else if (this.state.collectors[target]) {
      this.state.collectors[target].enabled = enabled;
      this.recreateJobsFor(target);
    }
    await this.persist();
    await vaultLog("info", `${target} ${enabled ? "enabled" : "disabled"}`);
  }

  async triggerRun(target: string): Promise<string> {
    if (target === "dream") {
      return this.runDream();
    }
    return this.runCollector(target);
  }

  // --- Private ---

  private async validateState(): Promise<void> {
    const knownSkills = await this.callbacks.getSkillNames();
    for (const name of Object.keys(this.state.collectors)) {
      if (!knownSkills.includes(name)) {
        await vaultLog("warn", `Removing schedule for unknown skill: ${name}`);
        delete this.state.collectors[name];
      }
    }
  }

  private async checkMissedRuns(): Promise<void> {
    const now = new Date();
    const gapMs = now.getTime() - new Date(this.state.lastHeartbeat).getTime();
    if (gapMs > 5 * 60 * 1000) {
      await vaultLog("warn", "Orchestrator was down", `gap: ${Math.round(gapMs / 60000)} minutes`);
    }

    for (const [name, col] of Object.entries(this.state.collectors)) {
      if (!col.enabled || col.schedules.length === 0) continue;
      if (!col.lastRun) {
        await vaultLog("info", `Missed run detected: ${name} (never run)`);
        this.runCollector(name).catch(() => {});
        continue;
      }
      // Check if any schedule was due since last run
      const lastRun = new Date(col.lastRun);
      for (const sched of col.schedules) {
        const cron = scheduleToCron(sched);
        try {
          const job = new Cron(cron);
          const prev = job.previousRun();
          if (prev && prev > lastRun) {
            await vaultLog("info", `Missed run detected: ${name}`);
            this.runCollector(name).catch(() => {});
            break;
          }
        } catch { /* invalid cron */ }
      }
    }
  }

  private createAllJobs(): void {
    for (const [name, col] of Object.entries(this.state.collectors)) {
      if (col.enabled) this.recreateJobsFor(name);
    }
  }

  private recreateJobsFor(skill: string): void {
    // Stop existing jobs
    const existing = this.jobs.get(skill);
    if (existing) {
      for (const job of existing) job.stop();
    }

    const col = this.state.collectors[skill];
    if (!col?.enabled || col.schedules.length === 0) {
      this.jobs.delete(skill);
      this.updateNextRun(skill);
      return;
    }

    const jobs: Cron[] = [];
    for (const sched of col.schedules) {
      const cron = scheduleToCron(sched);
      const job = new Cron(cron, () => {
        this.runCollector(skill).catch(() => {});
      });
      jobs.push(job);
    }
    this.jobs.set(skill, jobs);
    this.updateNextRun(skill);
  }

  private updateNextRun(skill: string): void {
    const col = this.state.collectors[skill];
    if (!col) return;

    const jobList = this.jobs.get(skill);
    if (!jobList || jobList.length === 0) {
      col.nextRun = null;
      return;
    }

    const nextRuns = jobList
      .map((j) => j.nextRun())
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());

    col.nextRun = nextRuns.length > 0 ? nextRuns[0].toISOString() : null;
  }

  private async runCollector(skill: string): Promise<string> {
    await vaultLog("info", `Orchestrator: running collector ${skill}`);
    const col = this.state.collectors[skill];

    const timeout = setTimeout(async () => {
      await vaultLog("warn", `Collector timeout: ${skill} (2 min)`);
    }, 120_000);

    try {
      const result = await this.callbacks.runCollector(skill);
      clearTimeout(timeout);

      if (col) {
        col.lastRun = new Date().toISOString();
        col.lastResult = result.success ? "success" : "error";
        col.lastError = result.success ? null : result.output;
        this.updateNextRun(skill);
      }

      // Barrier: track completion for today
      const today = getLocalDate();
      if (!this.state.dreamPipeline.collectorsCompletedToday.includes(skill)) {
        this.state.dreamPipeline.collectorsCompletedToday.push(skill);
      }

      await this.persist();
      await this.checkBarrier();

      await vaultLog("info", `Collector completed: ${skill}`, result.success ? "success" : result.output);
      return result.output;
    } catch (e: any) {
      clearTimeout(timeout);
      if (col) {
        col.lastRun = new Date().toISOString();
        col.lastResult = "error";
        col.lastError = e.message ?? String(e);
      }
      await this.persist();
      await vaultLog("error", `Collector failed: ${skill}`, e.message);
      throw e;
    }
  }

  private async runDream(): Promise<string> {
    await vaultLog("info", "Orchestrator: running dream pipeline");

    try {
      const result = await this.callbacks.runDreamPipeline();
      this.state.dreamPipeline.lastRun = new Date().toISOString();
      this.state.dreamPipeline.lastResult = result.success ? "success" : "error";
      this.state.dreamPipeline.lastError = result.success ? null : result.output;
      this.state.dreamPipeline.collectorsCompletedToday = [];
      await this.persist();
      await vaultLog("info", "Dream pipeline completed", result.success ? "success" : result.output);
      return result.output;
    } catch (e: any) {
      this.state.dreamPipeline.lastRun = new Date().toISOString();
      this.state.dreamPipeline.lastResult = "error";
      this.state.dreamPipeline.lastError = e.message ?? String(e);
      await this.persist();
      await vaultLog("error", "Dream pipeline failed", e.message);
      throw e;
    }
  }

  private async checkBarrier(): Promise<void> {
    if (!this.state.dreamPipeline.autoTrigger) return;

    const enabledCollectors = Object.entries(this.state.collectors)
      .filter(([, c]) => c.enabled && c.schedules.length > 0)
      .map(([name]) => name);

    if (enabledCollectors.length === 0) return;

    const allDone = enabledCollectors.every((name) =>
      this.state.dreamPipeline.collectorsCompletedToday.includes(name)
    );

    if (allDone) {
      // Check dream hasn't already run today
      const today = getLocalDate();
      const dreamLastRunDate = this.state.dreamPipeline.lastRun
        ? new Date(this.state.dreamPipeline.lastRun).toLocaleDateString("sv-SE")
        : null;

      if (dreamLastRunDate !== today) {
        await vaultLog("info", "Barrier met: all collectors done, triggering dream pipeline");
        this.runDream().catch(() => {});
      }
    }
  }

  private async heartbeat(): Promise<void> {
    // Reset collectorsCompletedToday on date change
    const today = getLocalDate();
    const heartbeatDate = new Date(this.state.lastHeartbeat).toLocaleDateString("sv-SE");
    if (heartbeatDate !== today) {
      this.state.dreamPipeline.collectorsCompletedToday = [];
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await saveState(this.vaultRoot, this.state);
    } catch (e: any) {
      await vaultLog("error", "Failed to save orchestrator state", e.message);
    }
  }
}
```

- [ ] **Step 4: Export Orchestrator class from index.ts**

Add to the existing orchestrator exports in `packages/core/src/index.ts`:

```typescript
export { Orchestrator, type OrchestratorCallbacks } from "./orchestrator.js";
```

- [ ] **Step 5: Build and run tests**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run
```

Expected: All tests pass (existing + new orchestrator tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/orchestrator.ts packages/core/src/index.ts packages/core/test/orchestrator.test.ts
git commit -m "feat(core): implement orchestrator engine with croner scheduling and barrier logic"
```

---

## Task 3: Add orchestrator endpoints to dev server

**Files:**
- Modify: `packages/ui/server.ts`

- [ ] **Step 1: Import and start orchestrator in server.ts**

At the top of `packages/ui/server.ts`, add the import (after existing imports):

```typescript
import { Orchestrator, type OrchestratorCallbacks } from "../core/dist/index.js";
```

Before the `app.listen` call, add orchestrator initialization:

```typescript
// --- Orchestrator ---

const orchestratorCallbacks: OrchestratorCallbacks = {
  runCollector: async (skillName: string) => {
    try {
      const skillsBin = join(process.cwd(), "..", "skills", "dist", "index.js");
      const { stderr } = await execFileAsync("node", [skillsBin, "--run", skillName], {
        env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
        timeout: 120000,
      });
      return { success: true, output: stderr || "Completed." };
    } catch (e: any) {
      return { success: false, output: e.stderr || e.message };
    }
  },
  runDreamPipeline: async () => {
    try {
      const dreamBin = join(process.cwd(), "..", "dream", "dist", "index.js");
      const { stderr } = await execFileAsync("node", [dreamBin], {
        env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
        timeout: 300000,
      });
      return { success: true, output: stderr || "Completed." };
    } catch (e: any) {
      return { success: false, output: e.stderr || e.message };
    }
  },
  getSkillNames: async () => {
    // Reuse the existing skill discovery logic
    const builtinDir = join(process.cwd(), "..", "skills", "builtin");
    const userDir = join(VAULT_ROOT, "skills");
    const names: string[] = [];
    for (const dir of [builtinDir, userDir]) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            try {
              await stat(join(dir, entry.name, "SKILL.md"));
              names.push(entry.name);
            } catch { /* no SKILL.md */ }
          }
        }
      } catch { /* dir doesn't exist */ }
    }
    return [...new Set(names)];
  },
};

const orchestrator = new Orchestrator(VAULT_ROOT, orchestratorCallbacks);
orchestrator.start().catch((e) => console.error("[orchestrator] Failed to start:", e));
```

- [ ] **Step 2: Add the 4 orchestrator API endpoints**

Add before `app.listen`:

```typescript
app.get("/api/orchestrator-status", async (_req, res) => {
  res.json({
    running: orchestrator.isRunning(),
    ...orchestrator.getStatus(),
  });
});

app.post("/api/orchestrator-schedule", async (req, res) => {
  const { skill, schedules, enabled } = req.body;
  if (!skill) return res.status(400).json({ error: "skill is required" });
  try {
    await orchestrator.updateSchedule(skill, schedules ?? [], enabled ?? true);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orchestrator-run", async (req, res) => {
  const { target } = req.body;
  if (!target) return res.status(400).json({ error: "target is required" });
  try {
    const output = await orchestrator.triggerRun(target);
    res.json({ ok: true, output });
  } catch (e: any) {
    res.json({ ok: false, output: e.message ?? String(e) });
  }
});

app.post("/api/orchestrator-toggle", async (req, res) => {
  const { target, enabled } = req.body;
  if (!target || enabled === undefined) return res.status(400).json({ error: "target and enabled are required" });
  try {
    await orchestrator.toggleSchedule(target, enabled);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Build and verify server starts**

```bash
pnpm build
pkill -f "tsx server.ts" 2>/dev/null; sleep 1
cd packages/ui && npx tsx server.ts &
sleep 3
curl -s http://localhost:3001/api/orchestrator-status | head
kill %1
```

Expected: Returns orchestrator status JSON.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/server.ts
git commit -m "feat(ui): add orchestrator endpoints and start on server boot"
```

---

## Task 4: Add bridge functions

**Files:**
- Modify: `packages/ui/src/lib/tauri-bridge.ts`

- [ ] **Step 1: Add orchestrator types and bridge functions**

Add to `packages/ui/src/lib/tauri-bridge.ts` (after the existing Claude Desktop functions):

```typescript
// --- Orchestrator ---

export interface OrchestratorSchedule {
  time: string;
  days: string[];
}

export interface OrchestratorCollector {
  enabled: boolean;
  schedules: OrchestratorSchedule[];
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  nextRun: string | null;
}

export interface OrchestratorDreamPipeline {
  autoTrigger: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError: string | null;
  collectorsCompletedToday: string[];
}

export interface OrchestratorStatus {
  running: boolean;
  lastHeartbeat: string;
  collectors: Record<string, OrchestratorCollector>;
  dreamPipeline: OrchestratorDreamPipeline;
}

export async function getOrchestratorStatus(): Promise<OrchestratorStatus> {
  if (isTauri) return tauriInvoke("get_orchestrator_status");
  return apiGet("/orchestrator-status");
}

export async function updateSchedule(skill: string, schedules: OrchestratorSchedule[], enabled: boolean): Promise<void> {
  if (isTauri) return tauriInvoke("update_schedule", { skill, schedules, enabled });
  await apiPost("/orchestrator-schedule", { skill, schedules, enabled });
}

export async function triggerOrchestratorRun(target: string): Promise<string> {
  if (isTauri) return tauriInvoke("trigger_orchestrator_run", { target });
  const result = await apiPost<{ output: string }>("/orchestrator-run", { target });
  return result.output;
}

export async function toggleOrchestratorSchedule(target: string, enabled: boolean): Promise<void> {
  if (isTauri) return tauriInvoke("toggle_orchestrator_schedule", { target, enabled });
  await apiPost("/orchestrator-toggle", { target, enabled });
}
```

- [ ] **Step 2: Verify UI builds**

```bash
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/tauri-bridge.ts
git commit -m "feat(ui): add orchestrator bridge functions and types"
```

---

## Task 5: Create Schedule page

**Files:**
- Create: `packages/ui/src/pages/schedule.ts`
- Modify: `packages/ui/src/main.ts`
- Modify: `packages/ui/index.html`
- Modify: `packages/ui/src/styles.css`

This is the largest task. The Schedule page has: status banner, collector cards with time pickers, unscheduled section, and dream pipeline section. All DOM built with safe methods.

- [ ] **Step 1: Create the schedule page**

Create `packages/ui/src/pages/schedule.ts`. The page should:

1. Import `getOrchestratorStatus`, `updateSchedule`, `triggerOrchestratorRun`, `toggleOrchestratorSchedule`, `getSkills` from bridge, and `log` from logger
2. On render, call `getOrchestratorStatus()` and `getSkills()` to get both orchestrator state and skill metadata (descriptions, eligibility)
3. Build a status banner at top showing orchestrator health
4. For each collector in state, render a card with:
   - Name + description (from skills data) + enable/disable toggle
   - Schedule tags showing human-readable schedules with x-to-remove
   - "Add schedule" button that reveals an inline time picker
   - Status row: last run, result badge, next run
   - "Run Now" button
5. Time picker (inline): hour dropdown (1-12), minute dropdown (00/15/30/45), AM/PM toggle, 7 day-toggle buttons (M T W T F S S), "Every day" and "Weekdays" shortcuts, Save/Cancel
6. Unscheduled section: skills that exist but have no orchestrator entry, with "Add schedule" button
7. Dream pipeline section at bottom: auto-trigger toggle, barrier progress, last run, Run Now
8. Poll `getOrchestratorStatus()` every 30 seconds to refresh state

Key UI functions:
- `renderSchedulePage(container)` — main entry
- `buildCollectorCard(skill, collectorState, skillData)` — returns HTMLElement
- `buildTimePicker(onSave)` — returns inline picker HTMLElement
- `buildDreamSection(dreamState, totalCollectors)` — returns HTMLElement
- `formatTime(time24)` — converts "19:00" to "7:00 PM"
- `formatDays(days)` — converts ["mon","tue","wed","thu","fri"] to "Weekdays"

- [ ] **Step 2: Add sidebar nav item**

In `packages/ui/index.html`, add between the Skills and Logs nav items:

```html
<button class="nav-item" data-page="schedule">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  <span>Schedule</span>
</button>
```

- [ ] **Step 3: Wire up in main.ts**

Add import:
```typescript
import { renderSchedule } from "./pages/schedule.js";
```

Add to pages map:
```typescript
schedule: renderSchedule,
```

- [ ] **Step 4: Add schedule page styles to styles.css**

```css
/* ---- Schedule page ---- */

.orchestrator-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.orchestrator-banner.running {
  background: rgba(34, 197, 94, 0.08);
  color: var(--success);
}

.orchestrator-banner.stopped {
  background: rgba(248, 113, 113, 0.08);
  color: var(--danger);
}

.schedule-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 0.85rem 1.25rem;
  margin-bottom: 0.5rem;
}

.schedule-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
}

.schedule-card-name {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--accent);
}

.schedule-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0.4rem 0;
}

.schedule-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.5rem;
  background: rgba(96, 165, 250, 0.1);
  color: var(--accent);
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 500;
}

.schedule-tag-remove {
  cursor: pointer;
  opacity: 0.6;
  font-size: 0.9rem;
  line-height: 1;
}

.schedule-tag-remove:hover {
  opacity: 1;
  color: var(--danger);
}

.schedule-meta {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 0.75rem;
  color: var(--text-tertiary);
  margin-bottom: 0.4rem;
}

.schedule-status-badge {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 0.25rem;
  vertical-align: middle;
}

/* Time picker */

.time-picker {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
  margin: 0.5rem 0;
}

.time-picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.time-picker select {
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.85rem;
}

.day-toggles {
  display: flex;
  gap: 0.25rem;
}

.day-toggle {
  width: 32px;
  height: 28px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
}

.day-toggle.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.day-shortcuts {
  display: flex;
  gap: 0.35rem;
  margin-top: 0.35rem;
}

.day-shortcut {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 0.73rem;
  cursor: pointer;
}

.day-shortcut:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}

/* Dream pipeline section */

.dream-section {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 0.85rem 1.25rem;
  margin-top: 1rem;
}

.barrier-progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0.4rem 0;
}

.barrier-bar {
  flex: 1;
  height: 4px;
  background: var(--border-subtle);
  border-radius: 2px;
  overflow: hidden;
}

.barrier-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s;
}

.unscheduled-section {
  margin-top: 1rem;
}

.unscheduled-section h4 {
  font-size: 0.85rem;
  color: var(--text-tertiary);
  margin-bottom: 0.5rem;
}
```

- [ ] **Step 5: Build and verify**

```bash
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/pages/schedule.ts packages/ui/src/main.ts packages/ui/index.html packages/ui/src/styles.css
git commit -m "feat(ui): add Schedule page with time pickers and barrier progress"
```

---

## Task 6: Update Dashboard and Skills pages

**Files:**
- Modify: `packages/ui/src/pages/dashboard.ts`
- Modify: `packages/ui/src/pages/skills.ts`

- [ ] **Step 1: Remove Refresh button from dashboard**

In `packages/ui/src/pages/dashboard.ts`, remove the Refresh button and its event handler. The pipeline section should only have the "Run Dream Pipeline" button.

Remove from the template:
```html
<button class="btn" id="btn-refresh">...</button>
```

Remove the event listener:
```typescript
document.getElementById("btn-refresh")?.addEventListener("click", refreshStats);
```

- [ ] **Step 2: Add "Set up schedule" link to skills page**

In `packages/ui/src/pages/skills.ts`, after the `installOutput.textContent = result;` line in the install success handler, add a link to the schedule page:

```typescript
      const scheduleLink = document.createElement("a");
      scheduleLink.href = "#schedule";
      scheduleLink.textContent = "Set up a schedule \u2192";
      scheduleLink.style.cssText = "display: block; margin-top: 0.5rem; color: var(--accent); font-size: 0.85rem;";
      installOutput.appendChild(scheduleLink);
```

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/dashboard.ts packages/ui/src/pages/skills.ts
git commit -m "feat(ui): remove Dashboard refresh button, add schedule link to Skills"
```

---

## Task 7: End-to-end verification

**Files:** No new files.

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

Expected: All packages build.

- [ ] **Step 2: Run all tests**

```bash
pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Start dev server and verify orchestrator**

```bash
pkill -f "tsx server.ts" 2>/dev/null; sleep 1
cd packages/ui && npx tsx server.ts &
sleep 3

# Check orchestrator is running
curl -s http://localhost:3001/api/orchestrator-status | python3 -c "import sys,json; d=json.load(sys.stdin); print('Running:', d['running']); print('Collectors:', list(d['collectors'].keys()))"

# Set a schedule for github-activity
curl -s -X POST http://localhost:3001/api/orchestrator-schedule \
  -H "Content-Type: application/json" \
  -d '{"skill":"github-activity","schedules":[{"time":"19:00","days":["mon","tue","wed","thu","fri"]}],"enabled":true}'

# Check it was saved
curl -s http://localhost:3001/api/orchestrator-status | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['collectors'].get('github-activity', {}), indent=2))"
```

Expected: Orchestrator running, schedule saved with nextRun populated.

- [ ] **Step 4: Open browser and test Schedule page**

Navigate to `http://localhost:1420/#schedule`. Verify:
1. Status banner shows "Orchestrator running"
2. Skills with schedules show as collector cards
3. Time picker works (add a schedule, verify it appears as a tag)
4. Run Now button works
5. Dream pipeline section shows barrier progress
6. Unscheduled skills appear at the bottom

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address e2e test issues"
```
