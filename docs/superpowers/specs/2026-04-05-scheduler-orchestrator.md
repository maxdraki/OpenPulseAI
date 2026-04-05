# Scheduler & Orchestrator — Design Spec

**Date:** 2026-04-05
**Status:** Approved

## Goal

Replace the manual skill-running UX with a visual scheduler. Users set schedules using time pickers and day selectors (no cron expressions). An orchestrator runs collectors on schedule and auto-triggers the dream pipeline when all collectors have completed for the day. Everything is instrumented, resilient, and visible in a new Schedule page.

## Decisions

- **croner** for cron scheduling (zero deps, compatible with existing cron-parser expressions)
- **Barrier pattern** for dream pipeline auto-trigger (not a full DAG engine)
- **JSON state file** for persistence across restarts (`vault/orchestrator-state.json`)
- **Multiple schedules per collector** (e.g. weekdays at 7pm + weekends at 10pm)
- **Time picker UI** — hour/minute/AM-PM dropdowns + day toggle buttons. No cron visible to users.
- **Orchestrator runs inside the dev server process** (and later inside Tauri). Only active while app is running.
- **Missed-run detection** on startup — if a task was due while the app was closed, run it immediately.
- **System tray** (Tauri, future) — so orchestrator runs when window is closed.

## Orchestrator Engine

### State File (`vault/orchestrator-state.json`)

```json
{
  "lastHeartbeat": "2026-04-05T10:00:00Z",
  "collectors": {
    "github-activity": {
      "enabled": true,
      "schedules": [
        { "time": "19:00", "days": ["mon", "tue", "wed", "thu", "fri"] },
        { "time": "22:00", "days": ["sat", "sun"] }
      ],
      "lastRun": "2026-04-04T19:02:14Z",
      "lastResult": "success",
      "lastError": null,
      "nextRun": "2026-04-05T19:00:00Z"
    }
  },
  "dreamPipeline": {
    "autoTrigger": true,
    "lastRun": "2026-04-04T22:35:00Z",
    "lastResult": "success",
    "lastError": null,
    "collectorsCompletedToday": ["github-activity", "weekly-rollup"]
  }
}
```

### Lifecycle

1. **Startup**: Load state file. Create croner jobs for all enabled schedules. Check for missed runs (compare `lastRun` + schedule to current time). If missed, run immediately. Start heartbeat (every 60s).
2. **Collector run**: Orchestrator spawns the skill runner (same as existing `runSkillNow`). On complete: update state (`lastRun`, `lastResult`, `lastError`). Add to `collectorsCompletedToday`. Check barrier.
3. **Barrier check**: If `collectorsCompletedToday` contains all enabled collectors AND `autoTrigger` is true AND dream pipeline hasn't run today → trigger dream pipeline.
4. **Dream pipeline run**: Spawn the dream pipeline process. On complete: update state. Clear `collectorsCompletedToday`. Log result.
5. **Schedule change**: UI calls update endpoint. Orchestrator updates state file, destroys old croner jobs for that collector, creates new ones.
6. **Shutdown**: Stop all croner jobs. Write final state.

### Schedule → Cron Conversion

The UI stores schedules as `{ time: "19:00", days: ["mon", "tue", "wed", "thu", "fri"] }`. The orchestrator converts this to a cron expression for croner:

- `{ time: "19:00", days: ["mon", "tue", "wed", "thu", "fri"] }` → `"0 19 * * 1-5"`
- `{ time: "22:00", days: ["sat", "sun"] }` → `"0 22 * * 0,6"`
- `{ time: "08:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }` → `"0 8 * * *"`

Multiple schedules per collector = multiple croner jobs. Only one run per day counts toward the barrier (deduplicated by local date).

### Reliability

**Health checks:**
- Heartbeat written to state file every 60 seconds
- On startup, if `lastHeartbeat` is older than 5 minutes, log a warning and trigger missed-run detection

**Self-healing:**
- Collector failure: log error, mark `lastResult: "error"`, keep schedule active (retry on next scheduled run)
- Collector timeout: kill after 2 minutes (configurable), log as error
- Dream pipeline timeout: kill after 5 minutes
- State file corruption: log error, start fresh (discover skills, use SKILL.md schedules as defaults)

**Atomic state writes:**
- Write to `orchestrator-state.tmp.json`, then rename to `orchestrator-state.json`
- Back up previous state as `orchestrator-state.prev.json` before each write

**Config validation on startup:**
1. Check each scheduled collector still exists as a skill
2. Check skill dependencies (eligible) — log warning for ineligible ones
3. Verify LLM provider is configured if dream auto-trigger is on
4. Remove schedules for deleted skills

**Instrumentation (all via vaultLog):**
- `info`: Orchestrator started/stopped, collector scheduled/completed, dream triggered/completed, heartbeat resumed after gap, schedule changed
- `warn`: Missed run detected, collector timeout, unknown skill in schedule, ineligible collector
- `error`: Collector failed, dream pipeline failed, state file corrupt

## Schedule Page UI

New sidebar page at `#schedule` (between Skills and Logs).

### Layout

**Status banner (top):**
- Green: "Orchestrator running — next: github-activity at 7:00pm"
- Red: "Orchestrator stopped" (heartbeat stale)

**Collector cards:**

Each card shows:
- Name + description
- Enable/disable toggle
- Schedule tags: "Weekdays at 7:00pm" "Weekends at 10:00pm" — each with × to remove
- "Add schedule" button
- Status row: last run + result badge (success/error) + next scheduled run
- Run Now button
- Error detail if last run failed

**Add schedule (inline, not modal):**
- Time: hour dropdown (1-12) + minute dropdown (00/15/30/45) + AM/PM toggle
- Days: 7 toggle buttons (M T W T F S S)
- Shortcut buttons: "Every day" "Weekdays"
- Save / Cancel buttons

**Unscheduled section (bottom of collector list):**
- Skills with no schedule configured, with "Add schedule" button
- Appears after installing a new skill

**Dream Pipeline section (bottom):**
- Auto-trigger toggle
- Barrier progress: "2 of 3 collectors completed today" with a visual progress indicator
- Last run + result
- Run Now override button

### Skills page integration

After successful skill install, show: "Skill installed! Set up a schedule →" linking to `#schedule`.

### Dashboard changes

- Remove Refresh button
- Keep "Run Dream Pipeline" button

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/orchestrator-status` | GET | Full orchestrator state (health, collectors, dream pipeline, barrier) |
| `POST /api/orchestrator-schedule` | POST | Create/update/delete schedule. Body: `{ skill, schedules, enabled }` |
| `POST /api/orchestrator-run` | POST | Trigger immediate run. Body: `{ target: "skill-name" \| "dream" }` |
| `POST /api/orchestrator-toggle` | POST | Enable/disable. Body: `{ target, enabled }` |

## Bridge Functions

```typescript
getOrchestratorStatus(): Promise<OrchestratorStatus>
updateSchedule(skill: string, schedules: Schedule[], enabled: boolean): Promise<void>
triggerRun(target: string): Promise<string>  // returns output
toggleSchedule(target: string, enabled: boolean): Promise<void>
```

## Files

### New

| File | Purpose |
|---|---|
| `packages/core/src/orchestrator.ts` | Orchestrator engine |
| `packages/core/test/orchestrator.test.ts` | Unit tests |
| `packages/ui/src/pages/schedule.ts` | Schedule page |

### Modified

| File | Change |
|---|---|
| `packages/core/src/index.ts` | Export orchestrator |
| `packages/core/package.json` | Add `croner` dependency |
| `packages/ui/src/main.ts` | Add schedule route |
| `packages/ui/index.html` | Add Schedule sidebar nav |
| `packages/ui/server.ts` | Add orchestrator endpoints, start orchestrator on boot |
| `packages/ui/src/lib/tauri-bridge.ts` | Add orchestrator bridge functions |
| `packages/ui/src/pages/dashboard.ts` | Remove Refresh button |
| `packages/ui/src/pages/skills.ts` | Add "Set up schedule →" after install |
| `packages/ui/src/styles.css` | Schedule page styles |

## Out of Scope (v1)

- System tray (Tauri — future, tracked in backlog)
- Rust orchestrator commands (Tauri backend — future)
- Notifications on completion/failure
- Schedule import/export
- DAG with inter-collector dependencies (barrier is sufficient for now)
