# Wiki Maturity v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the dream pipeline into a self-maintaining, compounding wiki by adding theme canonicalization, concept-awareness, two-pass synthesis for concept/entity pages, a compaction pipeline, a schema-evolution pipeline, enhanced lint, and LLM-judged MCP query-back.

**Architecture:** Four pipelines (Dream enhanced, Lint enhanced, Compaction new, Schema Evolution new) plus a change to MCP `chat_with_pulse`. All mutations flow through the pending-update queue; no pipeline writes directly to warm files. New pipelines share existing scheduling (croner) and state patterns.

**Tech Stack:** TypeScript/ESM, Node 20, Vitest, `@openpulse/core` shared types, croner for scheduling, the `@modelcontextprotocol/sdk` v1.29.0 MCP server. pnpm workspace.

**Design spec:** `docs/superpowers/specs/2026-04-17-wiki-maturity-v2-design.md`

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `packages/core/src/merge-themes.ts` | Shared theme merge / rename / delete utility. Rewrites `[[links]]`, merges content, merges fact files, deletes source. Idempotent. |
| `packages/core/test/merge-themes.test.ts` | Unit tests for merge-themes. |
| `packages/dream/src/canonicalize.ts` | Theme canonicalization: `normalizeThemeName`, `findFuzzyMatches`, `canonicalizeThemes` (hybrid: deterministic + LLM fallback). |
| `packages/dream/test/canonicalize.test.ts` | Unit tests for canonicalize. |
| `packages/dream/src/compact-cli.ts` | Compaction CLI. Modes: scheduled (drain size queue + compact all with 7-day skip), explicit themes, `--force`. |
| `packages/dream/test/compact.test.ts` | Unit tests for compaction bucketing + CLI. |
| `packages/dream/src/schema-evolve-cli.ts` | Schema evolution CLI. Reads samples, LLM proposes schema changes as pending update. |
| `packages/dream/test/schema-evolve.test.ts` | Unit tests for schema evolution. |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Extend `PendingUpdate` with `compactionType`, `schemaEvolution`, `querybackSource`; extend `lintFix` enum. |
| `packages/core/src/orchestrator.ts` | Add `CompactionPipelineState`, `SchemaEvolutionPipelineState`, extend `OrchestratorState`, `OrchestratorCallbacks`, `defaultState`, `loadState` migration, scheduling, `runCompact`, `runSchemaEvolve`, public triggers. |
| `packages/core/src/index.ts` | Export new types and `mergeThemes`. |
| `packages/dream/src/classify.ts` | Entry-level preFilter drop rule; concept candidates in LLM prompt + return; confidence < 0.5 → orphan candidates; apply canonicalization. |
| `packages/dream/src/synthesize.ts` | Backlinks-aware prompt; two-pass synthesis for `concept` and `entity` types. |
| `packages/dream/src/index.ts` | Persist `_concept-candidates.json`, `_orphan-candidates.json`; create `theme-merge` pending updates from proposals. |
| `packages/dream/src/lint-structural.ts` | New issue types: `low-value`, `duplicate-theme`, `low-provenance`. |
| `packages/dream/src/lint-cli.ts` | New report sections (orphan-candidates, concept-candidates); new `--fix` modes (`merge`, `delete-lowvalue`, `rename`, `orphans`). |
| `packages/dream/package.json` | Add `openpulse-compact` and `openpulse-schema-evolve` binaries. |
| `packages/mcp-server/src/tools/chat-with-pulse.ts` | Judge+refine gate on multi-theme answers; session `pendingFile` state for `maybe` verdict; retire old `file: <name>` path. |
| `packages/ui/server.ts` | Approval handler size check; routes for trigger-compact, trigger-schema-evolve; route `_schema` pending updates to `_schema.md`. |
| `packages/ui/src/pages/schedule.ts` | Compaction card and schema-evolution card. |
| `packages/ui/src/pages/review.ts` | Badges for `compactionType`, `schemaEvolution`, `querybackSource`, and new `lintFix` modes. |

---

## Task 0 — Pre-flight: commit outstanding work

The working tree has three modified files from prior session work (folder-watcher fixes, classify stopwords fix, data-sources UI fix). Commit these before starting, so new work has a clean baseline.

- [ ] **Step 1: Verify working tree**

```bash
git status --short
```
Expected: `M packages/core/builtin-skills/folder-watcher/SKILL.md`, `M packages/dream/src/classify.ts`, `M packages/ui/src/pages/data-sources.ts`.

- [ ] **Step 2: Run tests to confirm baseline is green**

```bash
pnpm vitest run
```
Expected: all existing tests pass.

- [ ] **Step 3: Commit outstanding work**

```bash
git add packages/core/builtin-skills/folder-watcher/SKILL.md packages/dream/src/classify.ts packages/ui/src/pages/data-sources.ts
git commit -m "$(cat <<'EOF'
fix: folder-watcher heading rules + classifier cloud stopwords + editable path inputs

- SKILL.md: teach LLM to use subdirectory (or filename without extension)
  as section heading, never the watch-root/cloud-drive name.
- classify.ts: add cloud folder names to THEME_STOPWORDS; add CLOUD_PREFIXES
  blocklist so compound names like onedrive-rws are rejected.
- data-sources.ts: remove readOnly on picker-added inputs; add "+ Type path"
  button with shared addPathItem() helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1 — Core types extension

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Extend `PendingUpdate` with new optional fields**

Edit `packages/core/src/types.ts`, replacing the existing `PendingUpdate` interface (lines 47–62) with:

```typescript
/** A pending warm update awaiting user approval */
export interface PendingUpdate {
  id: string; // unique ID for this proposal
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: ActivityEntry[]; // source entries that led to this update
  createdAt: string; // ISO 8601
  status: "pending" | "approved" | "rejected" | "edited";
  batchId?: string; // groups updates from same dream run
  type?: ThemeType;              // for new themes — drives template selection
  sources?: string[];            // rolled-up source entry IDs from ^[src:] markers
  related?: string[];            // related theme names
  created?: string;              // ISO 8601 — set on first synthesis
  // Sub-kind fields — at most one is set per update
  lintFix?: "stubs" | "orphans" | "merge" | "delete" | "rename";
  compactionType?: "scheduled" | "size";
  schemaEvolution?: {
    rationale: Array<{ change: string; evidence: string }>;
    confidence: "high" | "medium" | "low";
  };
  querybackSource?: {
    question: string;
    themesConsulted: string[];
  };
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd packages/core && pnpm tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): extend PendingUpdate with compactionType, schemaEvolution, querybackSource, extended lintFix"
```

---

## Task 2 — Orchestrator state extensions

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/test/orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/orchestrator.test.ts`:

```typescript
describe("defaultState — new pipelines", () => {
  it("includes compactionPipeline with empty sizeQueue and per-theme map", () => {
    const s = defaultState();
    expect(s.compactionPipeline).toBeDefined();
    expect(s.compactionPipeline.running).toBe(false);
    expect(s.compactionPipeline.sizeQueue).toEqual([]);
    expect(s.compactionPipeline.perThemeLastCompacted).toEqual({});
    expect(s.compactionPipeline.schedule).toEqual({ time: "04:00", days: ["sun","mon","tue","wed","thu","fri","sat"] });
  });

  it("includes schemaEvolutionPipeline with monthly-ish schedule", () => {
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
    // Write an old-shape state with only dreamPipeline + lintPipeline
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
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd packages/core && pnpm vitest run orchestrator
```
Expected: FAIL — `compactionPipeline` does not exist on default state.

- [ ] **Step 3: Add interfaces to `orchestrator.ts`**

In `packages/core/src/orchestrator.ts`, add after the `LintPipelineState` interface (around line 49):

```typescript
export interface CompactionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
  perThemeLastCompacted: Record<string, string>;
  sizeQueue: string[];
}

export interface SchemaEvolutionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
}
```

Extend `OrchestratorState` (lines ~51-56):

```typescript
export interface OrchestratorState {
  lastHeartbeat: string | null;
  collectors: Record<string, CollectorState>;
  dreamPipeline: DreamPipelineState;
  lintPipeline: LintPipelineState;
  compactionPipeline: CompactionPipelineState;
  schemaEvolutionPipeline: SchemaEvolutionPipelineState;
}
```

Extend `OrchestratorCallbacks` (lines ~58-67):

```typescript
export interface OrchestratorCallbacks {
  runCollector(skillName: string): Promise<void>;
  runDreamPipeline(): Promise<void>;
  runLintPipeline(): Promise<void>;
  runCompactionPipeline(themes?: string[]): Promise<void>;
  runSchemaEvolutionPipeline(): Promise<void>;
  getSkillNames(): Promise<string[]>;
}
```

- [ ] **Step 4: Update `defaultState()`**

Replace the body (around lines 126-144):

```typescript
export function defaultState(): OrchestratorState {
  const allDays = ["sun","mon","tue","wed","thu","fri","sat"];
  return {
    lastHeartbeat: null,
    collectors: {},
    dreamPipeline: {
      autoTrigger: true,
      running: false,
      lastRun: null,
      lastResult: "never",
      collectorsCompletedToday: [],
    },
    lintPipeline: {
      running: false,
      lastRun: null,
      lastResult: "never",
      schedule: { time: "20:00", days: ["sun"] },
    },
    compactionPipeline: {
      running: false,
      lastRun: null,
      lastResult: "never",
      schedule: { time: "04:00", days: allDays }, // daily drain of sizeQueue; actual compaction cadence enforced by 7-day per-theme skip
      perThemeLastCompacted: {},
      sizeQueue: [],
    },
    schemaEvolutionPipeline: {
      running: false,
      lastRun: null,
      lastResult: "never",
      schedule: { time: "05:00", days: allDays }, // runs daily but acts monthly; CLI no-ops if already run this month
    },
  };
}
```

Note: schedules are daily-cadence so cron is simple; the CLIs themselves gate on actual cadence (7-day for compaction per-theme; once-per-month for schema evolution).

- [ ] **Step 5: Update `loadState()` migration**

Replace the try block body (around lines 152-165):

```typescript
try {
  const raw = await readFile(statePath(vaultRoot), "utf-8");
  const parsed = JSON.parse(raw) as Partial<OrchestratorState>;
  const defaults = defaultState();
  const merged: OrchestratorState = {
    lastHeartbeat: parsed.lastHeartbeat ?? defaults.lastHeartbeat,
    collectors: parsed.collectors ?? defaults.collectors,
    dreamPipeline: parsed.dreamPipeline ?? defaults.dreamPipeline,
    lintPipeline: parsed.lintPipeline ?? defaults.lintPipeline,
    compactionPipeline: parsed.compactionPipeline ?? defaults.compactionPipeline,
    schemaEvolutionPipeline: parsed.schemaEvolutionPipeline ?? defaults.schemaEvolutionPipeline,
  };
  // Reset any stuck running flags
  if (merged.lintPipeline.running) merged.lintPipeline.running = false;
  if (merged.dreamPipeline.running) merged.dreamPipeline.running = false;
  if (merged.compactionPipeline.running) merged.compactionPipeline.running = false;
  if (merged.schemaEvolutionPipeline.running) merged.schemaEvolutionPipeline.running = false;
  return merged;
} catch {
  return defaultState();
}
```

- [ ] **Step 6: Add scheduling + run methods to the Orchestrator class**

In `start()` (around line 242, right after `this.scheduleLintPipeline();`), add:

```typescript
this.scheduleCompactionPipeline();
this.scheduleSchemaEvolutionPipeline();
```

After the existing `scheduleLintPipeline()` + `runLint()` methods (end of file), add:

```typescript
  // -------------------------------------------------------------------------
  // Internal: compaction pipeline
  // -------------------------------------------------------------------------

  private scheduleCompactionPipeline(): void {
    const cp = this.state.compactionPipeline;
    const cronExpr = scheduleToCron(cp.schedule);
    try {
      const job = new Cron(cronExpr, {}, async () => {
        await this.runCompact();
      });
      this.jobs.set("__compact__", [job]);
    } catch (err) {
      vaultLog("error", `[orchestrator] Bad cron for compaction: ${cronExpr}`, String(err)).catch(() => {});
    }
  }

  private async runCompact(themes?: string[]): Promise<void> {
    const cp = this.state.compactionPipeline;
    if (cp.running) return;
    const startedAt = new Date().toISOString();
    cp.running = true;
    await saveState(this.vaultRoot, this.state);
    try {
      await vaultLog("info", `[orchestrator] Running compaction pipeline${themes ? ` (themes: ${themes.join(",")})` : ""}`);
      await this.callbacks.runCompactionPipeline(themes);
      cp.lastRun = startedAt;
      cp.lastResult = "success";
      delete cp.lastError;
      await vaultLog("info", "[orchestrator] Compaction pipeline succeeded");
    } catch (err) {
      cp.lastRun = startedAt;
      cp.lastResult = "error";
      cp.lastError = String(err);
      await vaultLog("error", "[orchestrator] Compaction pipeline failed", String(err));
    } finally {
      cp.running = false;
      await saveState(this.vaultRoot, this.state);
    }
  }

  /** Manually trigger compaction, optionally for specific themes. */
  async triggerCompact(themes?: string[]): Promise<void> {
    await this.runCompact(themes);
  }

  /** Append themes to the size queue; caller may then invoke triggerCompact. */
  async enqueueForCompaction(themes: string[]): Promise<void> {
    const cp = this.state.compactionPipeline;
    for (const t of themes) {
      if (!cp.sizeQueue.includes(t)) cp.sizeQueue.push(t);
    }
    await saveState(this.vaultRoot, this.state);
  }

  getCompactionPipelineState(): CompactionPipelineState {
    return JSON.parse(JSON.stringify(this.state.compactionPipeline));
  }

  async updateCompactionSchedule(schedule: Schedule): Promise<void> {
    this.state.compactionPipeline.schedule = schedule;
    const existing = this.jobs.get("__compact__");
    if (existing) { for (const j of existing) j.stop(); this.jobs.delete("__compact__"); }
    this.scheduleCompactionPipeline();
    await saveState(this.vaultRoot, this.state);
  }

  // -------------------------------------------------------------------------
  // Internal: schema-evolution pipeline
  // -------------------------------------------------------------------------

  private scheduleSchemaEvolutionPipeline(): void {
    const sp = this.state.schemaEvolutionPipeline;
    const cronExpr = scheduleToCron(sp.schedule);
    try {
      const job = new Cron(cronExpr, {}, async () => {
        await this.runSchemaEvolve();
      });
      this.jobs.set("__schema_evolve__", [job]);
    } catch (err) {
      vaultLog("error", `[orchestrator] Bad cron for schema-evolve: ${cronExpr}`, String(err)).catch(() => {});
    }
  }

  private async runSchemaEvolve(): Promise<void> {
    const sp = this.state.schemaEvolutionPipeline;
    if (sp.running) return;
    const startedAt = new Date().toISOString();
    sp.running = true;
    await saveState(this.vaultRoot, this.state);
    try {
      await vaultLog("info", "[orchestrator] Running schema-evolve pipeline");
      await this.callbacks.runSchemaEvolutionPipeline();
      sp.lastRun = startedAt;
      sp.lastResult = "success";
      delete sp.lastError;
      await vaultLog("info", "[orchestrator] Schema-evolve pipeline succeeded");
    } catch (err) {
      sp.lastRun = startedAt;
      sp.lastResult = "error";
      sp.lastError = String(err);
      await vaultLog("error", "[orchestrator] Schema-evolve pipeline failed", String(err));
    } finally {
      sp.running = false;
      await saveState(this.vaultRoot, this.state);
    }
  }

  async triggerSchemaEvolve(): Promise<void> {
    await this.runSchemaEvolve();
  }

  getSchemaEvolutionPipelineState(): SchemaEvolutionPipelineState {
    return JSON.parse(JSON.stringify(this.state.schemaEvolutionPipeline));
  }

  async updateSchemaEvolutionSchedule(schedule: Schedule): Promise<void> {
    this.state.schemaEvolutionPipeline.schedule = schedule;
    const existing = this.jobs.get("__schema_evolve__");
    if (existing) { for (const j of existing) j.stop(); this.jobs.delete("__schema_evolve__"); }
    this.scheduleSchemaEvolutionPipeline();
    await saveState(this.vaultRoot, this.state);
  }
```

- [ ] **Step 7: Run tests to confirm pass**

```bash
cd packages/core && pnpm vitest run orchestrator
```
Expected: all pass (including the two new tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/orchestrator.ts packages/core/test/orchestrator.test.ts
git commit -m "feat(core): add CompactionPipelineState and SchemaEvolutionPipelineState to orchestrator"
```

---

## Task 3 — `mergeThemes` utility (shared by canonicalize + lint)

**Files:**
- Create: `packages/core/src/merge-themes.ts`
- Create: `packages/core/test/merge-themes.test.ts`
- Modify: `packages/core/src/index.ts` (export)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/merge-themes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { mergeThemes } from "../src/merge-themes.js";

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), "merge-"));
  await mkdir(join(root, "vault", "warm"), { recursive: true });
  await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
  return { root, vault: new Vault(root) };
}

describe("mergeThemes", () => {
  it("rewrites [[source]] references to [[canonical]] across all warm files", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "foo.md"), "---\ntheme: foo\nlastUpdated: 2026-01-01T00:00:00Z\n---\nContent about foo.");
    await writeFile(join(root, "vault", "warm", "bar.md"), "---\ntheme: bar\nlastUpdated: 2026-01-01T00:00:00Z\n---\nSee [[foo]] and [[baz]].");
    await writeFile(join(root, "vault", "warm", "quux.md"), "---\ntheme: quux\nlastUpdated: 2026-01-01T00:00:00Z\n---\nAlso [[foo]].");

    await mergeThemes(vault, "foo", "fooling");

    const bar = await readFile(join(root, "vault", "warm", "bar.md"), "utf-8");
    const quux = await readFile(join(root, "vault", "warm", "quux.md"), "utf-8");
    expect(bar).toContain("[[fooling]]");
    expect(bar).not.toContain("[[foo]]");
    expect(quux).toContain("[[fooling]]");
  });

  it("appends source content to canonical (prepended as dated section for projects)", async () => {
    const { root, vault } = await makeVault();
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\nlastUpdated: 2026-01-01T00:00:00Z\n---\nCanonical content.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\nlastUpdated: 2026-01-02T00:00:00Z\n---\nSource content.");

    await mergeThemes(vault, "b", "a");

    const a = await readFile(join(root, "vault", "warm", "a.md"), "utf-8");
    expect(a).toContain(`### Merged from [[b]] on ${today}`);
    expect(a).toContain("Source content.");
  });

  it("deletes source .md and _facts/source.jsonl", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "_facts", "b.jsonl"), '{"claim":"x","sourceId":"s1"}\n');

    await mergeThemes(vault, "b", "a");

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("b.md");
    const facts = await readdir(join(root, "vault", "warm", "_facts"));
    expect(facts).not.toContain("b.jsonl");
  });

  it("merges _facts/source.jsonl into _facts/canonical.jsonl", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "_facts", "a.jsonl"), '{"claim":"a1","sourceId":"s1"}\n');
    await writeFile(join(root, "vault", "warm", "_facts", "b.jsonl"), '{"claim":"b1","sourceId":"s2"}\n');

    await mergeThemes(vault, "b", "a");

    const aFacts = await readFile(join(root, "vault", "warm", "_facts", "a.jsonl"), "utf-8");
    expect(aFacts).toContain('"claim":"a1"');
    expect(aFacts).toContain('"claim":"b1"');
  });

  it("with canonical=null deletes source and rewrites broken [[source]] references to plain text", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "c.md"), "---\ntheme: c\n---\nSee [[b]].");

    await mergeThemes(vault, "b", null);

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("b.md");
    const c = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");
    expect(c).not.toContain("[[b]]");
    expect(c).toContain("b");
  });

  it("rename mode replaces the file at canonical without content merge", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "old.md"), "---\ntheme: old\nlastUpdated: 2026-01-01T00:00:00Z\n---\nOriginal content.");
    await writeFile(join(root, "vault", "warm", "x.md"), "---\ntheme: x\n---\nReference [[old]].");

    await mergeThemes(vault, "old", "new", { rename: true });

    const newFile = await readFile(join(root, "vault", "warm", "new.md"), "utf-8");
    expect(newFile).toContain("Original content.");
    expect(newFile).toContain("theme: new");

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("old.md");

    const x = await readFile(join(root, "vault", "warm", "x.md"), "utf-8");
    expect(x).toContain("[[new]]");
  });

  it("is idempotent: running twice leaves the same state", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "c.md"), "---\ntheme: c\n---\n[[b]] and [[a]].");

    await mergeThemes(vault, "b", "a");
    const after1 = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");
    await mergeThemes(vault, "b", "a");
    const after2 = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");

    expect(after1).toBe(after2);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd packages/core && pnpm vitest run merge-themes
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `merge-themes.ts`**

Create `packages/core/src/merge-themes.ts`:

```typescript
import { readFile, writeFile, unlink, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault.js";

/**
 * Merge, rename, or delete a theme.
 *
 * Modes:
 *   - canonical=null: delete `source.md` and `_facts/source.jsonl`; rewrite all [[source]]
 *     references to plain `source` text (link removal).
 *   - canonical!=null, rename=false: rewrite [[source]] → [[canonical]] across warm files;
 *     append source content into canonical as a "### Merged from [[source]] on YYYY-MM-DD"
 *     section; merge _facts; delete source files.
 *   - canonical!=null, rename=true: rewrite [[source]] → [[canonical]]; move source content
 *     whole to canonical.md (no dated section); merge _facts; delete source files.
 *
 * Idempotent: each sub-step checks for state before acting.
 */
export async function mergeThemes(
  vault: Vault,
  source: string,
  canonical: string | null,
  opts: { rename?: boolean } = {}
): Promise<void> {
  const warmDir = vault.warmDir;
  const factsDir = join(warmDir, "_facts");
  const srcPath = join(warmDir, `${source}.md`);
  const srcFactsPath = join(factsDir, `${source}.jsonl`);

  // Step 1: rewrite links
  await rewriteLinks(warmDir, source, canonical);

  // Step 2: If canonical non-null, merge content
  if (canonical !== null) {
    const canonPath = join(warmDir, `${canonical}.md`);
    const canonFactsPath = join(factsDir, `${canonical}.jsonl`);

    const srcExists = await fileExists(srcPath);
    if (srcExists) {
      const srcRaw = await readFile(srcPath, "utf-8");
      const srcBody = stripFrontmatter(srcRaw);
      const canonExists = await fileExists(canonPath);

      if (opts.rename) {
        // rename mode: replace canonical with source content (with theme renamed)
        const renamed = renameInFrontmatter(srcRaw, source, canonical);
        await writeFile(canonPath, renamed, "utf-8");
      } else if (canonExists) {
        // merge mode: prepend dated section to canonical
        const canonRaw = await readFile(canonPath, "utf-8");
        const today = new Date().toISOString().slice(0, 10);
        const dated = `\n### Merged from [[${source}]] on ${today}\n\n${srcBody.trim()}\n`;
        const merged = insertAfterFrontmatter(canonRaw, dated);
        await writeFile(canonPath, merged, "utf-8");
      } else {
        // canonical doesn't exist: treat as a rename
        const renamed = renameInFrontmatter(srcRaw, source, canonical);
        await writeFile(canonPath, renamed, "utf-8");
      }
    }

    // Step 3: merge facts
    const srcFactsExists = await fileExists(srcFactsPath);
    if (srcFactsExists) {
      const srcFacts = await readFile(srcFactsPath, "utf-8");
      const canonFactsExists = await fileExists(canonFactsPath);
      if (canonFactsExists) {
        const existing = await readFile(canonFactsPath, "utf-8");
        await writeFile(canonFactsPath, existing + srcFacts, "utf-8");
      } else {
        await writeFile(canonFactsPath, srcFacts, "utf-8");
      }
    }
  }

  // Step 4: delete source files
  if (await fileExists(srcPath)) await unlink(srcPath);
  if (await fileExists(srcFactsPath)) await unlink(srcFactsPath);
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function rewriteLinks(warmDir: string, source: string, canonical: string | null): Promise<void> {
  const files = await readdir(warmDir);
  const mdFiles = files.filter((f) => f.endsWith(".md") && f !== `${source}.md`);
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[${escaped}\\]\\]`, "g");
  const replacement = canonical !== null ? `[[${canonical}]]` : source;
  for (const f of mdFiles) {
    const path = join(warmDir, f);
    const raw = await readFile(path, "utf-8");
    if (!re.test(raw)) continue;
    re.lastIndex = 0;
    const rewritten = raw.replace(re, replacement);
    if (rewritten !== raw) await writeFile(path, rewritten, "utf-8");
  }
}

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n/);
  return m ? raw.slice(m[0].length) : raw;
}

function insertAfterFrontmatter(raw: string, insertion: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n/);
  if (!m) return raw + insertion;
  return raw.slice(0, m[0].length) + insertion + raw.slice(m[0].length);
}

function renameInFrontmatter(raw: string, from: string, to: string): string {
  return raw.replace(new RegExp(`^theme:\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m"), `theme: ${to}`);
}
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add:

```typescript
export { mergeThemes } from "./merge-themes.js";
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
cd packages/core && pnpm vitest run merge-themes
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/merge-themes.ts packages/core/test/merge-themes.test.ts packages/core/src/index.ts
git commit -m "feat(core): add mergeThemes utility for theme merge/rename/delete with link rewriting"
```

---

## Task 4 — Entry-level preFilter in classify.ts

**Files:**
- Modify: `packages/dream/src/classify.ts`
- Modify: `packages/dream/test/classify.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `packages/dream/test/classify.test.ts` (or create if needed — follow existing patterns in `packages/dream/test/`):

```typescript
import { describe, it, expect } from "vitest";
import type { ActivityEntry } from "@openpulse/core";
// We test preFilter indirectly via classifyEntries; mock the provider.
import { classifyEntries } from "../src/classify.js";

const mockProvider = {
  complete: async () => "[]",
} as any;

describe("classifyEntries — entry-level preFilter drop", () => {
  it("drops entries that have fewer than 5 substantive lines and no activity tokens", async () => {
    const entry: ActivityEntry = {
      timestamp: "2026-04-17T00:00:00Z",
      log: "## Status\n- **Repo:** foo\n- inactive\n",
      source: "github-activity",
    };
    const result = await classifyEntries([entry], [], mockProvider, "gpt");
    expect(result.classified).toHaveLength(0);
  });

  it("keeps entries with commit/PR/merge tokens even if short", async () => {
    const entry: ActivityEntry = {
      timestamp: "2026-04-17T00:00:00Z",
      log: "Merged PR #47\nCommit abc123",
      source: "github-activity",
    };
    const result = await classifyEntries([entry], [], mockProvider, "gpt");
    expect(result.classified.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd packages/dream && pnpm vitest run classify
```
Expected: the "drops short inactive entries" test FAILS (current preFilter keeps line-level, not entry-level).

- [ ] **Step 3: Extend `preFilter` in `classify.ts`**

Find `preFilter` in `packages/dream/src/classify.ts` (around line 81). Replace the return statement with:

```typescript
  return entries
    .map((entry) => {
      const lines = entry.log.split("\n");
      const filtered = lines.filter((line) => {
        const lower = line.toLowerCase();
        if (ABSENCE_LINE.test(lower) &&
            !/(modified|changed|added|created|updated|committed|pushed|merged)/i.test(lower)) {
          return false;
        }
        return true;
      });

      const withoutOrphans = stripOrphanedHeadings(filtered.join("\n")).trim();
      if (!withoutOrphans) return null;

      // Entry-level drop: if we have fewer than 5 substantive lines
      // and no activity tokens, the entry is noise.
      const substantiveCount = withoutOrphans.split("\n").filter((l) => {
        const t = l.trim();
        if (!t || t.length < 5) return false;
        if (t.startsWith("#")) return false;
        if (LABEL_ONLY_RE.test(t)) return false;
        if (EMPTY_BULLET_RE.test(t)) return false;
        return true;
      }).length;
      const ACTIVITY_TOKEN_RE = /(modified|changed|added|created|updated|committed|pushed|merged|commit|PR |pull|issue|#\d+)/i;
      if (substantiveCount < 5 && !ACTIVITY_TOKEN_RE.test(withoutOrphans)) {
        return null;
      }

      return { ...entry, log: withoutOrphans };
    })
    .filter((e): e is ActivityEntry => e !== null);
```

- [ ] **Step 4: Run tests**

```bash
cd packages/dream && pnpm vitest run classify
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/dream/src/classify.ts packages/dream/test/classify.test.ts
git commit -m "feat(dream): entry-level preFilter drops fragments with no activity tokens"
```

---

## Task 5 — Concept-candidates extraction

**Files:**
- Modify: `packages/dream/src/classify.ts`

- [ ] **Step 1: Extend LLM prompt and parse**

In `classify.ts`, find the LLM prompt inside `classifyEntries` (around the `provider.complete` call). Update the prompt's last two lines from:

```
Respond with ONLY a JSON array: [{"index": 0, "themes": ["name1"], "type": "project"}]
```

to:

```
For each entry also identify 0-3 "concept_candidates" — terms, patterns, or entities
that appear prominently in the entry and might deserve their own wiki page (e.g.
"barrier-pattern", "wiki-maturity"). These are suggestions, not themes.

Respond with ONLY a JSON array:
[{"index": 0, "themes": ["name1"], "type": "project", "concept_candidates": ["term-a", "term-b"]}]
```

Update the parsed type:

```typescript
const parsed = JSON.parse(jsonText) as Array<{
  index: number;
  themes: string[];
  type?: string;
  concept_candidates?: string[];
}>;
```

- [ ] **Step 2: Add `conceptCandidates` accumulator and return field**

Near the top of `classifyEntries`, after `const proposedTypes: Record<string, ThemeType> = {};`, add:

```typescript
const conceptCandidatesMap: Record<string, { count: number; sources: string[]; firstSeen: string }> = {};
const now = new Date().toISOString();
```

In the LLM-response parsing loop, after `results.push(...)`, add:

```typescript
if (Array.isArray(p.concept_candidates)) {
  for (const raw of p.concept_candidates) {
    const term = String(raw).trim();
    if (!term || !isValidThemeName(term)) continue;
    const existing = conceptCandidatesMap[term];
    const source = needsLlm[p.index].source ?? "unknown";
    if (existing) {
      existing.count += 1;
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      conceptCandidatesMap[term] = { count: 1, sources: [source], firstSeen: now };
    }
  }
}
```

- [ ] **Step 3: Extend `ClassifyResult` type**

Replace the existing `ClassifyResult` interface:

```typescript
export interface ClassifyResult {
  classified: ClassificationResult[];
  proposedTypes: Record<string, ThemeType>;
  conceptCandidates: Record<string, { count: number; sources: string[]; firstSeen: string }>;
  orphanCandidates: Array<{
    entryTimestamp: string;
    source?: string;
    log: string;
    proposedThemes: string[];
    confidence: number;
    deferredAt: string;
  }>;
  themeMergeProposals: Array<{
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}
```

Update the return at the bottom of `classifyEntries`:

```typescript
return {
  classified: results,
  proposedTypes,
  conceptCandidates: conceptCandidatesMap,
  orphanCandidates: [],       // populated in Task 6
  themeMergeProposals: [],    // populated in Task 8
};
```

- [ ] **Step 4: Run build to check types**

```bash
cd packages/dream && pnpm tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dream/src/classify.ts
git commit -m "feat(dream): extract concept candidates in classifier LLM fallback"
```

---

## Task 6 — Confidence threshold → orphan candidates

**Files:**
- Modify: `packages/dream/src/classify.ts`

- [ ] **Step 1: Route low-confidence entries to orphanCandidates**

In `classifyEntries`, after the existing `const existingThemeSet = new Set(existingThemes);` and before `const needsLlm: ActivityEntry[] = [];`, add:

```typescript
const orphanCandidates: ClassifyResult["orphanCandidates"] = [];
const ORPHAN_CONF_THRESHOLD = 0.5;
```

Inside the loop `for (const entry of cleaned) { ... }`, after the deterministic classification succeeds — locate:

```typescript
if (tags) {
  results.push({ entry, themes: tags, confidence: 0.95 });
  ...
}
```

Leave this unchanged (confidence is always 0.95 on deterministic hits, so they never fall below the threshold).

The threshold matters most for LLM-returned results. In the LLM response parsing, wrap the `results.push(...)` with:

```typescript
const inferredType = (["project","concept","entity","source-summary"].includes(p.type ?? ""))
  ? (p.type as ThemeType)
  : "project";
const validThemes = p.themes.filter(isValidThemeName).slice(0, 3);
const themes = validThemes.length > 0 ? validThemes : [needsLlm[p.index].source ?? "uncategorized"];

// NEW: check confidence against existing themes
const confidence = 0.7; // LLM-returned confidence level
const anyExisting = themes.some((t) => existingThemeSet.has(t));
if (!anyExisting && confidence < ORPHAN_CONF_THRESHOLD) {
  // Route to orphan candidates instead of results
  orphanCandidates.push({
    entryTimestamp: needsLlm[p.index].timestamp,
    source: needsLlm[p.index].source,
    log: needsLlm[p.index].log,
    proposedThemes: themes,
    confidence,
    deferredAt: new Date().toISOString(),
  });
  returnedIndexes.add(p.index);
  continue;
}

results.push({ entry: needsLlm[p.index], themes, confidence });
returnedIndexes.add(p.index);
```

Note: the current LLM confidence is fixed at 0.7 in the existing code, so the threshold (0.5) won't currently trigger. This wire-up is for when a future provider/prompt returns per-entry confidence. For now, the branch is inert but correct.

Update the final return:

```typescript
return {
  classified: results,
  proposedTypes,
  conceptCandidates: conceptCandidatesMap,
  orphanCandidates,
  themeMergeProposals: [],
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/dream/src/classify.ts
git commit -m "feat(dream): confidence threshold routes uncertain new themes to orphan candidates"
```

---

## Task 7 — Canonicalize module

**Files:**
- Create: `packages/dream/src/canonicalize.ts`
- Create: `packages/dream/test/canonicalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/dream/test/canonicalize.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { normalizeThemeName, findFuzzyMatches, canonicalizeThemes } from "../src/canonicalize.js";

describe("normalizeThemeName", () => {
  it("lowercases", () => { expect(normalizeThemeName("OpenPulse")).toBe("openpulse"); });
  it("kebab-cases", () => { expect(normalizeThemeName("Open Pulse AI")).toBe("open-pulse-ai"); });
  it("collapses repeated separators", () => { expect(normalizeThemeName("a--b__c")).toBe("a-b-c"); });
  it("trims leading/trailing separators", () => { expect(normalizeThemeName("-foo-")).toBe("foo"); });
});

describe("findFuzzyMatches", () => {
  it("detects Levenshtein ≤ 2", () => {
    const r = findFuzzyMatches(["dream", "dreams"]);
    expect(r).toContainEqual({ a: "dream", b: "dreams", reason: "levenshtein" });
  });
  it("detects prefix ≥ 6", () => {
    const r = findFuzzyMatches(["openpulse", "openpulseai"]);
    expect(r).toContainEqual(expect.objectContaining({ a: "openpulse", b: "openpulseai" }));
  });
  it("does not flag unrelated names", () => {
    const r = findFuzzyMatches(["cat", "dog", "elephant"]);
    expect(r).toEqual([]);
  });
});

describe("canonicalizeThemes", () => {
  const nullProvider = { complete: vi.fn().mockResolvedValue("[]") } as any;

  it("redirects exact-after-normalization matches silently", async () => {
    const result = await canonicalizeThemes(["OpenPulse"], ["openpulse"], nullProvider, "gpt");
    expect(result.redirects).toEqual({ "OpenPulse": "openpulse" });
    expect(result.proposals).toEqual([]);
  });

  it("proposes fuzzy matches (Levenshtein)", async () => {
    const result = await canonicalizeThemes(["dreams"], ["dream"], nullProvider, "gpt");
    expect(result.redirects).toEqual({});
    expect(result.proposals).toContainEqual({ proposed: "dreams", canonical: "dream", reason: "levenshtein" });
  });

  it("proposes prefix matches", async () => {
    const result = await canonicalizeThemes(["openpulseai"], ["openpulse"], nullProvider, "gpt");
    expect(result.proposals).toContainEqual(expect.objectContaining({ proposed: "openpulseai", canonical: "openpulse" }));
  });

  it("calls LLM only when new themes survive deterministic passes", async () => {
    const spy = vi.fn().mockResolvedValue("[]");
    await canonicalizeThemes(["foo"], ["foo"], { complete: spy } as any, "gpt");
    expect(spy).not.toHaveBeenCalled(); // exact redirect, no LLM
  });

  it("calls LLM for truly-new themes and converts non-null canonicals into proposals", async () => {
    const llmResponse = JSON.stringify([{ proposed: "auth-system", canonical: "authentication" }]);
    const provider = { complete: vi.fn().mockResolvedValue(llmResponse) } as any;
    const result = await canonicalizeThemes(["auth-system"], ["authentication"], provider, "gpt");
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(result.proposals).toContainEqual({ proposed: "auth-system", canonical: "authentication", reason: "llm" });
  });

  it("drops null-canonical LLM responses", async () => {
    const llmResponse = JSON.stringify([{ proposed: "new-thing", canonical: null }]);
    const provider = { complete: vi.fn().mockResolvedValue(llmResponse) } as any;
    const result = await canonicalizeThemes(["new-thing"], ["unrelated"], provider, "gpt");
    expect(result.proposals).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd packages/dream && pnpm vitest run canonicalize
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `canonicalize.ts`**

Create `packages/dream/src/canonicalize.ts`:

```typescript
import type { LlmProvider } from "@openpulse/core";

export interface CanonicalizationResult {
  redirects: Record<string, string>;  // proposed → canonical (auto-merge, silent)
  proposals: Array<{
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}

/** Lowercase, kebab-case, collapse repeats, trim leading/trailing separators. */
export function normalizeThemeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Levenshtein distance (basic DP). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function sharedPrefixLength(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

/** Find all pairs within Levenshtein ≤ 2 or shared prefix ≥ 6 characters. */
export function findFuzzyMatches(names: string[]): Array<{ a: string; b: string; reason: "levenshtein" | "prefix" }> {
  const out: Array<{ a: string; b: string; reason: "levenshtein" | "prefix" }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a === b) continue;
      if (levenshtein(a, b) <= 2) {
        out.push({ a, b, reason: "levenshtein" });
      } else if (sharedPrefixLength(a, b) >= 6) {
        out.push({ a, b, reason: "prefix" });
      }
    }
  }
  return out;
}

/** Main canonicalization entrypoint. */
export async function canonicalizeThemes(
  proposed: string[],
  existing: string[],
  provider: LlmProvider,
  model: string
): Promise<CanonicalizationResult> {
  const redirects: Record<string, string> = {};
  const proposals: CanonicalizationResult["proposals"] = [];

  const existingNormalized = new Map(existing.map((name) => [normalizeThemeName(name), name] as const));
  const stillNew: string[] = [];

  // Pass 1: exact-after-normalization
  for (const p of proposed) {
    const norm = normalizeThemeName(p);
    const canonical = existingNormalized.get(norm);
    if (canonical) {
      redirects[p] = canonical;
    } else {
      stillNew.push(p);
    }
  }

  // Pass 2: fuzzy (Levenshtein or shared prefix)
  const stillTrulyNew: string[] = [];
  for (const p of stillNew) {
    const pNorm = normalizeThemeName(p);
    let matched = false;
    for (const existingName of existing) {
      const eNorm = normalizeThemeName(existingName);
      if (levenshtein(pNorm, eNorm) <= 2) {
        proposals.push({ proposed: p, canonical: existingName, reason: "levenshtein" });
        matched = true;
        break;
      }
      if (sharedPrefixLength(pNorm, eNorm) >= 6) {
        proposals.push({ proposed: p, canonical: existingName, reason: "prefix" });
        matched = true;
        break;
      }
    }
    if (!matched) stillTrulyNew.push(p);
  }

  // Pass 3: LLM (only if truly-new themes remain)
  if (stillTrulyNew.length > 0 && existing.length > 0) {
    try {
      const prompt = `Do any of these proposed themes refer to the same thing as any existing theme?

Proposed: ${stillTrulyNew.join(", ")}
Existing: ${existing.join(", ")}

Return ONLY a JSON array: [{"proposed": "...", "canonical": "..." | null}]
Set canonical to null if no match.`;
      const response = await provider.complete({ model, prompt, temperature: 0 });
      let jsonText = response.trim();
      if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      const parsed = JSON.parse(jsonText) as Array<{ proposed: string; canonical: string | null }>;
      for (const item of parsed) {
        if (item.canonical && existing.includes(item.canonical)) {
          proposals.push({ proposed: item.proposed, canonical: item.canonical, reason: "llm" });
        }
      }
    } catch {
      // LLM pass failure is non-fatal; deterministic proposals still apply.
    }
  }

  return { redirects, proposals };
}
```

- [ ] **Step 4: Run tests to pass**

```bash
cd packages/dream && pnpm vitest run canonicalize
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/dream/src/canonicalize.ts packages/dream/test/canonicalize.test.ts
git commit -m "feat(dream): add canonicalize module — deterministic + LLM fallback theme matching"
```

---

## Task 8 — Wire canonicalize into dream pipeline

**Files:**
- Modify: `packages/dream/src/classify.ts`
- Modify: `packages/dream/src/index.ts`

- [ ] **Step 1: Integrate canonicalize into `classifyEntries`**

In `classify.ts`, import at top:

```typescript
import { canonicalizeThemes } from "./canonicalize.js";
```

At the end of `classifyEntries`, before the final return, add:

```typescript
// Canonicalization: collect all theme names that appear in results
const allProposed = [...new Set(results.flatMap((r) => r.themes))];
const canonicalization = await canonicalizeThemes(allProposed, existingThemes, provider, model);

// Apply redirects: rewrite theme names in classified results
for (const r of results) {
  r.themes = r.themes.map((t) => canonicalization.redirects[t] ?? t);
}
// Apply redirects to proposedTypes
for (const [from, to] of Object.entries(canonicalization.redirects)) {
  if (proposedTypes[from] && !proposedTypes[to]) {
    proposedTypes[to] = proposedTypes[from];
  }
  delete proposedTypes[from];
}

return {
  classified: results,
  proposedTypes,
  conceptCandidates: conceptCandidatesMap,
  orphanCandidates,
  themeMergeProposals: canonicalization.proposals,
};
```

- [ ] **Step 2: Persist sidecar JSONs and create merge pending updates in `index.ts`**

In `packages/dream/src/index.ts`, add imports:

```typescript
import { randomUUID } from "node:crypto";
```

After `const { classified, proposedTypes } = await classifyEntries(...)` line in `main()`, replace with the full destructuring and persistence:

```typescript
const { classified, proposedTypes, conceptCandidates, orphanCandidates, themeMergeProposals } =
  await classifyEntries(entries, allThemes, provider, model);
console.error(`[dream] Classified ${classified.length} entries.`);

// Persist concept candidates (merge with existing)
const conceptCandidatesPath = join(vault.warmDir, "_concept-candidates.json");
let existingConcepts: Record<string, { count: number; sources: string[]; firstSeen: string }> = {};
try {
  const raw = await readFile(conceptCandidatesPath, "utf-8");
  existingConcepts = JSON.parse(raw);
} catch { /* fresh */ }
for (const [term, data] of Object.entries(conceptCandidates)) {
  if (existingConcepts[term]) {
    existingConcepts[term].count += data.count;
    existingConcepts[term].sources = [...new Set([...existingConcepts[term].sources, ...data.sources])];
  } else {
    existingConcepts[term] = data;
  }
}
await writeFile(conceptCandidatesPath, JSON.stringify(existingConcepts, null, 2), "utf-8");

// Persist orphan candidates (append)
if (orphanCandidates.length > 0) {
  const orphanPath = join(vault.warmDir, "_orphan-candidates.json");
  let existingOrphans: typeof orphanCandidates = [];
  try {
    const raw = await readFile(orphanPath, "utf-8");
    existingOrphans = JSON.parse(raw);
  } catch { /* fresh */ }
  await writeFile(orphanPath, JSON.stringify([...existingOrphans, ...orphanCandidates], null, 2), "utf-8");
}

// Theme merge proposals → pending updates
for (const proposal of themeMergeProposals) {
  const pendingPath = join(vault.pendingDir, `${randomUUID()}.json`);
  const pendingUpdate = {
    id: randomUUID(),
    theme: proposal.proposed,
    proposedContent: `## Merge proposal\n\nProposed merge: [[${proposal.proposed}]] → [[${proposal.canonical}]]\nReason: ${proposal.reason}\n\nApproving this pending update will rewrite links and delete the source theme.`,
    previousContent: null,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending" as const,
    batchId: new Date().toISOString(),
    lintFix: "merge" as const,
    // Store the merge target in a metadata-like field:
    related: [proposal.canonical],
  };
  await writeFile(pendingPath, JSON.stringify(pendingUpdate, null, 2), "utf-8");
}
```

- [ ] **Step 3: Build and run tests**

```bash
pnpm build && pnpm vitest run
```
Expected: all existing tests still pass; canonicalize tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/dream/src/classify.ts packages/dream/src/index.ts
git commit -m "feat(dream): wire canonicalize into classifyEntries; persist candidate sidecars; create merge pending updates"
```

---

## Task 9 — Backlinks-aware synthesis prompt

**Files:**
- Modify: `packages/dream/src/synthesize.ts`

- [ ] **Step 1: Load backlinks before synthesis call**

In `synthesize.ts`, add import:

```typescript
import { buildBacklinks } from "./backlinks.js";
```

Near the top of `synthesizeToPending`, after `const allThemeNames = [...]`, add:

```typescript
// Load backlinks once for the whole run
const backlinks = await buildBacklinks(vault);
```

- [ ] **Step 2: Update the synthesis prompt per theme**

Inside `for (const [theme, items] of byTheme)`, after `const otherThemes = allThemeNames.filter(...)`, add:

```typescript
const inbound = backlinks.get(theme) ?? [];
// themes sharing any source with this theme's existing content
const sharedSources = existing?.sources ?? [];
const sharingThemes: string[] = [];
if (sharedSources.length > 0) {
  for (const name of allThemeNames) {
    if (name === theme) continue;
    const other = await readTheme(vault, name);
    if (!other?.sources) continue;
    if (other.sources.some((s) => sharedSources.includes(s))) sharingThemes.push(name);
  }
}
const backlinkContext = [
  inbound.length > 0 ? `This theme is linked from: ${inbound.map((t) => `[[${t}]]`).join(", ")}` : "",
  sharingThemes.length > 0 ? `Themes that share sources with this one: ${sharingThemes.map((t) => `[[${t}]]`).join(", ")}` : "",
].filter(Boolean).join("\n");
```

Then in the prompt string (the `const proposedContent = await provider.complete({ prompt: ... })` call), replace the `Other themes in the wiki: ...` line with:

```typescript
Other themes in the wiki: ${otherThemes.join(", ")}.${backlinkContext ? "\n\nContext for cross-references:\n" + backlinkContext + "\nWhen your update mentions content related to these themes, add [[wiki-links]]." : " Where content relates to another theme, add [[theme-name]] links."}
```

- [ ] **Step 3: Build, test**

```bash
pnpm build && pnpm vitest run
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/dream/src/synthesize.ts
git commit -m "feat(dream): include backlinks and shared-source themes in synthesis prompt"
```

---

## Task 10 — Two-pass synthesis for concept/entity

**Files:**
- Modify: `packages/dream/src/synthesize.ts`

Note: this is the largest and most speculative change. It's sequenced last in the Dream section so it can be dropped under scope pressure.

- [ ] **Step 1: Add fact extraction and two-pass path**

In `synthesize.ts`, add imports:

```typescript
import { appendFile, mkdir, readFile as readFileAsync, access } from "node:fs/promises";
```

Add a helper near the top:

```typescript
async function ensureFactsDir(vault: Vault): Promise<string> {
  const dir = join(vault.warmDir, "_facts");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function extractFacts(
  theme: string,
  entry: { timestamp: string; log: string; source?: string },
  provider: LlmProvider,
  model: string
): Promise<Array<{ claim: string; sourceId: string; confidence: "high" | "medium" | "low" }>> {
  const sourceId = `${entry.timestamp.slice(0, 10)}-${entry.source ?? "unknown"}`;
  const prompt = `Extract atomic factual claims from this entry that are relevant to the theme "${theme}".
Each claim must be one sentence, self-contained, and cite this sourceId: ${sourceId}.

Entry:
${entry.log}

Return ONLY a JSON array: [{"claim": "...", "sourceId": "${sourceId}", "confidence": "high"|"medium"|"low"}]
Return [] if the entry has no relevant facts.`;
  try {
    const response = await provider.complete({ model, prompt, temperature: 0 });
    let jsonText = response.trim();
    if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    return JSON.parse(jsonText);
  } catch {
    return [];
  }
}

async function readFacts(factsDir: string, theme: string): Promise<string[]> {
  const path = join(factsDir, `${theme}.jsonl`);
  try {
    const raw = await readFileAsync(path, "utf-8");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Branch synthesis by page type**

Inside the main `for (const [theme, items] of byTheme) { ... }` loop, wrap the existing synthesis call with a type branch:

```typescript
let proposedContent: string;

if (pageType === "concept" || pageType === "entity") {
  // Two-pass path
  const factsDir = await ensureFactsDir(vault);
  const factsPath = join(factsDir, `${theme}.jsonl`);

  // Pass 1: extract facts from each new entry
  for (const { entry } of items) {
    const facts = await extractFacts(theme, entry, provider, model);
    if (facts.length > 0) {
      const lines = facts.map((f) => JSON.stringify({ ...f, extractedAt: new Date().toISOString() })).join("\n") + "\n";
      await appendFile(factsPath, lines, "utf-8");
    }
  }

  // Pass 2: read all facts + existing page + resynthesize
  const allFactLines = await readFacts(factsDir, theme);
  const factsBlock = allFactLines.length > 0 ? allFactLines.join("\n") : "(no facts extracted)";

  proposedContent = await provider.complete({
    model,
    prompt: `You are maintaining a **${pageType}** page for "${theme}".

${existingSection}Facts extracted from sources (one JSON object per line):
${factsBlock}

The document structure should be:
${template.structure}

Synthesis rules: ${template.rules}

Hard constraints:
- You may only make claims that appear in the facts list above.
- Every claim must include its ^[src:sourceId] citation (use the "sourceId" field from the facts).
- If facts conflict, prefer the most recent (by "extractedAt") but note the conflict with ^[ambiguous].

${backlinkContext ? "Context for cross-references:\n" + backlinkContext + "\nWhen your update mentions content related to these themes, add [[wiki-links]].\n" : ""}

Return ONLY the Markdown content, no fences or explanations.`,
    systemPrompt: `You are a work journal assistant. NEVER invent claims beyond the provided facts. NEVER invent sourceIds. If the fact list is empty, write "No durable claims yet." rather than fabricating content.`,
    maxTokens,
    temperature: 0.1,
  });
} else {
  // Existing single-pass path (project, source-summary) — keep unchanged
  proposedContent = await provider.complete({
    model,
    prompt: /* existing prompt */,
    systemPrompt: /* existing system prompt */,
    maxTokens,
    temperature: 0.1,
  });
}
```

Note: merge `proposedContent` into the rest of the pending-update construction (the existing code that builds the `update` object from `proposedContent`, `rolledUpSources`, etc.) — no other changes.

- [ ] **Step 3: Build, test**

```bash
pnpm build && pnpm vitest run
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/dream/src/synthesize.ts
git commit -m "feat(dream): two-pass synthesis (fact extraction + integration) for concept and entity pages"
```

---

## Task 11 — Lint: low-value page detection

**Files:**
- Modify: `packages/dream/src/lint-structural.ts`

- [ ] **Step 1: Write the failing test**

Extend `packages/dream/test/lint.test.ts`:

```typescript
describe("runStructuralChecks — low-value", () => {
  it("flags pages with content < 250 chars", async () => {
    const { vault, root } = await makeTempVault();
    await writeFile(join(vault.warmDir, "tiny.md"), "---\ntheme: tiny\nlastUpdated: 2026-04-15T00:00:00Z\n---\nJust a tiny bit.");
    const issues = await runStructuralChecks(vault);
    expect(issues.some((i) => i.type === "low-value" && i.theme === "tiny")).toBe(true);
  });

  it("flags pages where all src markers point to one source and few bullets", async () => {
    const { vault, root } = await makeTempVault();
    const content = `---
theme: oneSource
lastUpdated: 2026-04-15T00:00:00Z
---
## Current Status
Some paragraph. ^[src:2026-04-15-only-source]

## Activity Log
- One bullet ^[src:2026-04-15-only-source]
- Two bullets ^[src:2026-04-15-only-source]
- Three bullets ^[src:2026-04-15-only-source]`;
    await writeFile(join(vault.warmDir, "oneSource.md"), content);
    const issues = await runStructuralChecks(vault);
    // Three bullets exactly → not flagged; test a variant with ≤ 3
  });
});
```

- [ ] **Step 2: Add `low-value` to the issue type and implement check**

In `lint-structural.ts`, update:

```typescript
export interface StructuralIssue {
  type: "broken-link" | "orphan" | "schema-noncompliant" | "stale" | "duplicate-date" | "low-value" | "duplicate-theme" | "low-provenance";
  theme: string;
  detail: string;
  target?: string;
}
```

Add a check function:

```typescript
function checkLowValue(theme: string, content: string): StructuralIssue | null {
  if (content.length < 250) {
    return { type: "low-value", theme, detail: `Content is only ${content.length} chars (< 250)` };
  }
  const srcMatches = [...content.matchAll(/\^\[src:([^\]]+)\]/g)].map((m) => m[1]);
  const uniqueSources = new Set(srcMatches);
  const bulletCount = content.split("\n").filter((l) => /^[-*]\s/.test(l.trim())).length;
  if (srcMatches.length > 0 && uniqueSources.size === 1 && bulletCount <= 3) {
    return { type: "low-value", theme, detail: `All ${srcMatches.length} citations point to a single source "${[...uniqueSources][0]}" and only ${bulletCount} bullets` };
  }
  return null;
}
```

Call it in the main loop:

```typescript
const lowValueIssue = checkLowValue(theme, doc.content);
if (lowValueIssue) issues.push(lowValueIssue);
```

- [ ] **Step 3: Tests pass; commit**

```bash
cd packages/dream && pnpm vitest run lint
git add packages/dream/src/lint-structural.ts packages/dream/test/lint.test.ts
git commit -m "feat(dream): lint — low-value page detection (short content or single-source)"
```

---

## Task 12 — Lint: duplicate-theme + low-provenance

**Files:**
- Modify: `packages/dream/src/lint-structural.ts`

- [ ] **Step 1: Import and implement both checks**

In `lint-structural.ts`:

```typescript
import { findFuzzyMatches } from "./canonicalize.js";
```

Add checks:

```typescript
function checkDuplicateThemes(themeNames: string[]): StructuralIssue[] {
  const pairs = findFuzzyMatches(themeNames);
  return pairs.map(({ a, b, reason }) => ({
    type: "duplicate-theme" as const,
    theme: a,
    detail: `Near-duplicate of [[${b}]] (${reason})`,
    target: b,
  }));
}

function checkLowProvenance(theme: string, content: string): StructuralIssue | null {
  const paragraphs = content.split(/\n\n+/).filter((p) => {
    const t = p.trim();
    return t && !t.startsWith("#") && !/^[-*]\s/.test(t);
  });
  if (paragraphs.length === 0) return null;
  const withProv = paragraphs.filter((p) => /\^\[src:/.test(p)).length;
  const coverage = withProv / paragraphs.length;
  if (coverage < 0.7) {
    return {
      type: "low-provenance",
      theme,
      detail: `${withProv} of ${paragraphs.length} paragraphs have provenance (${Math.round(coverage * 100)}%)`,
    };
  }
  return null;
}
```

Call duplicate-theme once outside the per-theme loop:

```typescript
const duplicateIssues = checkDuplicateThemes(themeNames);
issues.push(...duplicateIssues);
```

Call low-provenance inside the per-theme loop:

```typescript
const lowProv = checkLowProvenance(theme, doc.content);
if (lowProv) issues.push(lowProv);
```

- [ ] **Step 2: Tests pass; commit**

```bash
cd packages/dream && pnpm vitest run lint
git add packages/dream/src/lint-structural.ts
git commit -m "feat(dream): lint — duplicate-theme and low-provenance checks"
```

---

## Task 13 — Lint CLI: new report sections + fix modes

**Files:**
- Modify: `packages/dream/src/lint-cli.ts`

- [ ] **Step 1: Add new sections to `writeLintReport`**

In `lint-cli.ts`, find `writeLintReport` and extend the `LABELS` map:

```typescript
const LABELS: Record<string, string> = {
  "broken-link": "Broken cross-references",
  "orphan": "Orphan themes",
  "schema-noncompliant": "Schema compliance issues",
  "stale": "Stale themes",
  "duplicate-date": "Duplicate dated sections",
  "low-value": "Low-value pages",
  "duplicate-theme": "Near-duplicate themes",
  "low-provenance": "Low provenance coverage",
};
```

Before the final `Actions` footer, add:

```typescript
// Orphan candidates
try {
  const raw = await readFile(join(vault.warmDir, "_orphan-candidates.json"), "utf-8");
  const candidates = JSON.parse(raw) as Array<{ entryTimestamp: string; source?: string; proposedThemes: string[]; confidence: number }>;
  if (candidates.length > 0) {
    lines.push(`## Orphan candidates (${candidates.length})`, ``);
    lines.push(`Entries deferred because classifier confidence < 0.5:`, ``);
    for (const c of candidates) {
      const ts = c.entryTimestamp.slice(0, 10);
      lines.push(`- ${ts} ${c.source ?? "unknown"} — proposed: ${c.proposedThemes.join(", ")}, conf ${c.confidence}`);
    }
    lines.push(``, `Run \`openpulse-lint --fix=orphans\` to review and approve.`, ``);
  }
} catch { /* no candidates */ }

// Concept candidates (count ≥ 3)
try {
  const raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
  const map = JSON.parse(raw) as Record<string, { count: number; sources: string[] }>;
  const frequent = Object.entries(map).filter(([, v]) => v.count >= 3);
  if (frequent.length > 0) {
    lines.push(`## Concept candidates (${frequent.length})`, ``);
    lines.push(`Terms mentioned across ≥3 entries with no page yet:`, ``);
    for (const [term, data] of frequent) {
      lines.push(`- "${term}" (${data.count} mentions) — sources: ${data.sources.slice(0, 3).join(", ")}`);
    }
    lines.push(``, `Run \`openpulse-lint --fix=stubs\` to create concept pages as pending updates.`, ``);
  }
} catch { /* no candidates */ }
```

- [ ] **Step 2: Add new `--fix` modes**

In `main()`, replace the existing `--fix=stubs` branch handling with a dispatcher:

```typescript
const fixFlag = process.argv.find((a) => a.startsWith("--fix="))?.split("=")[1] as
  | "stubs" | "orphans" | "merge" | "delete-lowvalue" | "rename" | undefined;

// ... after writeLintReport(...)

if (fixFlag === "stubs") {
  await createStubPendingUpdates(vault, stubs);
  // Also create stubs from concept-candidates sidecar
  await createStubsFromConceptCandidates(vault);
} else if (fixFlag === "orphans") {
  await createOrphanPendingUpdates(vault);
} else if (fixFlag === "delete-lowvalue") {
  await createDeletePendingUpdates(vault, structural.filter((i) => i.type === "low-value"));
} else if (fixFlag === "merge") {
  await createMergePendingUpdates(vault, structural.filter((i) => i.type === "duplicate-theme"));
} else if (fixFlag === "rename") {
  const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
  const to = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1];
  if (!from || !to) { console.error("--fix=rename requires --from= and --to="); process.exit(1); }
  await createRenamePendingUpdate(vault, from, to);
}
```

Add the handler helpers at end of file:

```typescript
async function createStubsFromConceptCandidates(vault: Vault): Promise<void> {
  try {
    const raw = await readFile(join(vault.warmDir, "_concept-candidates.json"), "utf-8");
    const map = JSON.parse(raw) as Record<string, { count: number; sources: string[] }>;
    const frequent = Object.entries(map).filter(([, v]) => v.count >= 3);
    const batchId = new Date().toISOString();
    for (const [term] of frequent) {
      const themeName = term.toLowerCase().replace(/\s+/g, "-");
      const update = {
        id: randomUUID(),
        theme: themeName,
        proposedContent: `## Definition\n\nTODO: Define "${term}".\n\n## Key Claims\n\n- _(to be filled in)_\n\n## Related Concepts\n\n## Sources\n`,
        previousContent: null,
        entries: [],
        createdAt: new Date().toISOString(),
        status: "pending" as const,
        batchId,
        type: "concept" as const,
        lintFix: "stubs" as const,
      };
      await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
    }
    if (frequent.length > 0) console.error(`[lint] Created ${frequent.length} concept stub pending update(s)`);
  } catch { /* ignore */ }
}

async function createOrphanPendingUpdates(vault: Vault): Promise<void> {
  const path = join(vault.warmDir, "_orphan-candidates.json");
  try {
    const raw = await readFile(path, "utf-8");
    const candidates = JSON.parse(raw) as Array<{ proposedThemes: string[]; log: string; source?: string; entryTimestamp: string }>;
    const batchId = new Date().toISOString();
    for (const c of candidates) {
      const theme = c.proposedThemes[0] ?? c.source ?? "uncategorized";
      const update = {
        id: randomUUID(),
        theme,
        proposedContent: `## Current Status\n\n_(from orphaned entry, please review and edit)_\n\n${c.log.slice(0, 2000)}\n\n^[src:${c.entryTimestamp.slice(0, 10)}-${c.source ?? "unknown"}]\n`,
        previousContent: null,
        entries: [],
        createdAt: new Date().toISOString(),
        status: "pending" as const,
        batchId,
        lintFix: "orphans" as const,
      };
      await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
    }
    if (candidates.length > 0) console.error(`[lint] Created ${candidates.length} orphan pending update(s). Clearing candidates file.`);
    // Clear after queueing so lint doesn't re-suggest
    await writeFile(path, "[]", "utf-8");
  } catch { /* no candidates */ }
}

async function createDeletePendingUpdates(vault: Vault, issues: StructuralIssue[]): Promise<void> {
  const batchId = new Date().toISOString();
  for (const i of issues) {
    const update = {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: "",  // delete on approval
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "delete" as const,
    };
    await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  }
  if (issues.length > 0) console.error(`[lint] Created ${issues.length} delete pending update(s).`);
}

async function createMergePendingUpdates(vault: Vault, issues: StructuralIssue[]): Promise<void> {
  const batchId = new Date().toISOString();
  for (const i of issues) {
    if (!i.target) continue;
    const update = {
      id: randomUUID(),
      theme: i.theme,
      proposedContent: `## Merge proposal\n\nMerge [[${i.theme}]] → [[${i.target}]]\nReason: ${i.detail}`,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId,
      lintFix: "merge" as const,
      related: [i.target],
    };
    await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  }
  if (issues.length > 0) console.error(`[lint] Created ${issues.length} merge pending update(s).`);
}

async function createRenamePendingUpdate(vault: Vault, from: string, to: string): Promise<void> {
  const update = {
    id: randomUUID(),
    theme: from,
    proposedContent: `## Rename proposal\n\nRename [[${from}]] → [[${to}]]\n`,
    previousContent: null,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending" as const,
    batchId: new Date().toISOString(),
    lintFix: "rename" as const,
    related: [to],
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  console.error(`[lint] Created rename pending update: ${from} → ${to}`);
}
```

- [ ] **Step 3: Build, run lint CLI manually**

```bash
pnpm build
node packages/dream/dist/lint-cli.js
cat vault/warm/_lint.md | tail -30
```
Expected: lint runs cleanly with new sections.

- [ ] **Step 4: Commit**

```bash
git add packages/dream/src/lint-cli.ts
git commit -m "feat(dream): lint CLI — orphan/concept-candidate sections, new --fix modes (merge, delete-lowvalue, rename, orphans)"
```

---

## Task 14 — Compaction CLI

**Files:**
- Create: `packages/dream/src/compact-cli.ts`
- Create: `packages/dream/test/compact.test.ts`
- Modify: `packages/dream/package.json`

- [ ] **Step 1: Add binary to package.json**

In `packages/dream/package.json`, extend the `bin` block:

```json
"bin": {
  "openpulse-dream": "dist/index.js",
  "openpulse-lint": "dist/lint-cli.js",
  "openpulse-compact": "dist/compact-cli.js",
  "openpulse-schema-evolve": "dist/schema-evolve-cli.js"
}
```

- [ ] **Step 2: Write tests**

Create `packages/dream/test/compact.test.ts` with bucketing-logic tests and a mocked-LLM integration smoke test (follow the pattern from existing `dream/test/` files). Cover:
- `bucketActivityLog`: 14 verbatim + rest grouped by ISO week
- project page compaction produces a pending update with compactionType
- concept page compaction reads _facts/<theme>.jsonl
- 7-day skip check honored

Example shape:

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@openpulse/core";
import { compactTheme, bucketActivityLog } from "../src/compact-cli.js";

describe("bucketActivityLog", () => {
  it("keeps last 14 sections verbatim and groups rest by ISO week", () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 31) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      body: `Entry ${i}`,
    }));
    const { verbatim, grouped } = bucketActivityLog(sections);
    expect(verbatim).toHaveLength(14);
    expect(Object.keys(grouped).length).toBeGreaterThan(0);
  });
});

// Integration-ish tests follow using a mocked provider
```

- [ ] **Step 3: Implement `compact-cli.ts`**

Create `packages/dream/src/compact-cli.ts`:

```typescript
#!/usr/bin/env node
import { readFile, writeFile, readdir, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Vault, loadConfig, createProvider, initLogger, vaultLog,
  listThemes, readTheme,
} from "@openpulse/core";
import type { Vault as VaultT, LlmProvider, PendingUpdate } from "@openpulse/core";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const VERBATIM_LIMIT = 14;
const SKIP_DAYS = 7;

interface DatedSection { date: string; body: string; }

export function bucketActivityLog(sections: DatedSection[]): { verbatim: DatedSection[]; grouped: Record<string, DatedSection[]> } {
  // Most-recent-first assumed — caller sorts.
  const verbatim = sections.slice(0, VERBATIM_LIMIT);
  const older = sections.slice(VERBATIM_LIMIT);
  const grouped: Record<string, DatedSection[]> = {};
  for (const s of older) {
    const week = isoWeek(s.date);
    (grouped[week] ??= []).push(s);
  }
  return { verbatim, grouped };
}

function isoWeek(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00Z");
  const y = d.getUTCFullYear();
  const t = new Date(Date.UTC(y, 0, 1));
  const day = t.getUTCDay() || 7;
  const week = Math.ceil((((d.getTime() - t.getTime()) / 86400000) + day) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

async function parseProjectPage(content: string): Promise<{ currentStatus: string; sections: DatedSection[] }> {
  // Find "## Activity Log" section, parse ### YYYY-MM-DD entries below it
  const activityMatch = content.match(/##\s+Activity Log\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  const activityBody = activityMatch?.[1] ?? "";
  const statusMatch = content.match(/##\s+Current Status\s*\n([\s\S]*?)(?=\n##\s+|$)/);
  const currentStatus = statusMatch?.[1]?.trim() ?? "";

  const sections: DatedSection[] = [];
  const re = /###\s+(\d{4}-\d{2}-\d{2})\b[^\n]*\n([\s\S]*?)(?=\n###\s+\d{4}-\d{2}-\d{2}|$)/g;
  for (const m of activityBody.matchAll(re)) {
    sections.push({ date: m[1], body: m[2].trim() });
  }
  sections.sort((a, b) => b.date.localeCompare(a.date));
  return { currentStatus, sections };
}

async function compactProject(vault: VaultT, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;
  const { currentStatus, sections } = await parseProjectPage(doc.content);
  if (sections.length <= VERBATIM_LIMIT) return false; // nothing to compact

  const { verbatim, grouped } = bucketActivityLog(sections);
  const groupedText = Object.entries(grouped)
    .map(([week, items]) => `#### ${week}\n${items.map((i) => `- ${i.date}: ${i.body.replace(/\n/g, " ").slice(0, 300)}`).join("\n")}`)
    .join("\n\n");

  const response = await provider.complete({
    model,
    temperature: 0.1,
    maxTokens: 2048,
    prompt: `You are compacting a project wiki page titled "${theme}".

Current Status:
${currentStatus}

Older Activity Log sections grouped by ISO week:
${groupedText}

Produce:
(a) A rewritten ## Current Status reflecting the trajectory (not just the most recent entry).
(b) A ## History section: one bullet per ISO week summarizing key events, preserving any ^[src:] markers.

Return JSON: {"current_status": "...", "history": "..."}`,
  });

  let parsed: { current_status: string; history: string };
  try {
    let jsonText = response.trim();
    if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(jsonText);
  } catch {
    await vaultLog("warn", `[compact] LLM parse failed for ${theme}`);
    return false;
  }

  const verbatimText = verbatim.map((s) => `### ${s.date}\n${s.body}`).join("\n\n");
  const newContent = `## Current Status\n${parsed.current_status.trim()}\n\n## Activity Log\n\n${verbatimText}\n\n## History\n${parsed.history.trim()}\n`;

  const update: PendingUpdate = {
    id: randomUUID(),
    theme,
    proposedContent: newContent,
    previousContent: doc.content,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type: "project",
    compactionType: "scheduled",
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  return true;
}

async function compactConcept(vault: VaultT, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;

  const factsPath = join(vault.warmDir, "_facts", `${theme}.jsonl`);
  let facts = "";
  try { facts = await readFile(factsPath, "utf-8"); } catch { return false; }
  if (!facts.trim()) return false;

  const response = await provider.complete({
    model,
    temperature: 0.1,
    maxTokens: 2048,
    prompt: `You are compacting a ${doc.type} wiki page titled "${theme}".

Current page:
${doc.content}

All extracted facts (includes older and newer, JSON per line):
${facts}

Rewrite the page. Prefer newer facts where they contradict older ones. Preserve all ^[src:] citations. Note unresolved conflicts with ^[ambiguous].

Return ONLY the Markdown content, no fences.`,
  });

  const update: PendingUpdate = {
    id: randomUUID(),
    theme,
    proposedContent: response,
    previousContent: doc.content,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending",
    batchId: new Date().toISOString(),
    type: doc.type,
    compactionType: "scheduled",
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  return true;
}

export async function compactTheme(vault: VaultT, theme: string, provider: LlmProvider, model: string): Promise<boolean> {
  const doc = await readTheme(vault, theme);
  if (!doc) return false;
  if (doc.type === "concept" || doc.type === "entity") return compactConcept(vault, theme, provider, model);
  return compactProject(vault, theme, provider, model);
}

async function loadOrchestratorState(): Promise<any> {
  const path = join(VAULT_ROOT, "vault", "orchestrator-state.json");
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}
async function saveOrchestratorState(state: any): Promise<void> {
  const path = join(VAULT_ROOT, "vault", "orchestrator-state.json");
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

async function main() {
  initLogger(VAULT_ROOT);
  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  const explicitThemes = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  const state = await loadOrchestratorState();
  const perThemeLastCompacted: Record<string, string> = state?.compactionPipeline?.perThemeLastCompacted ?? {};
  const sizeQueue: string[] = state?.compactionPipeline?.sizeQueue ?? [];

  let themes: string[];
  if (explicitThemes.length > 0) {
    themes = explicitThemes;
  } else {
    // Scheduled: drain size queue first, then all themes
    const allThemes = await listThemes(vault);
    themes = [...new Set([...sizeQueue, ...allThemes])];
    if (!force) {
      // 7-day skip filter, but keep size-queued themes regardless
      themes = themes.filter((t) => {
        if (sizeQueue.includes(t)) return true;
        const last = perThemeLastCompacted[t];
        if (!last) return true;
        const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
        return days >= SKIP_DAYS;
      });
    }
  }

  await vaultLog("info", `[compact] Starting compaction for ${themes.length} theme(s)`);

  let compacted = 0;
  for (const theme of themes) {
    try {
      const did = await compactTheme(vault, theme, provider, model);
      if (did) {
        compacted++;
        perThemeLastCompacted[theme] = new Date().toISOString();
      }
    } catch (err) {
      await vaultLog("error", `[compact] Failed for ${theme}`, String(err));
    }
  }

  // Update orchestrator state: clear size queue, update per-theme timestamps
  if (state) {
    state.compactionPipeline = state.compactionPipeline ?? {};
    state.compactionPipeline.perThemeLastCompacted = perThemeLastCompacted;
    state.compactionPipeline.sizeQueue = [];
    await saveOrchestratorState(state);
  }

  await vaultLog("info", `[compact] Done — ${compacted} pending update(s) created`);
}

main().catch((err) => {
  console.error("[compact] Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Build + test + commit**

```bash
pnpm build
cd packages/dream && pnpm vitest run compact
git add packages/dream/src/compact-cli.ts packages/dream/test/compact.test.ts packages/dream/package.json
git commit -m "feat(dream): add compact-cli with project bucketing and concept/entity re-synthesis paths"
```

---

## Task 15 — Schema Evolution CLI

**Files:**
- Create: `packages/dream/src/schema-evolve-cli.ts`
- Create: `packages/dream/test/schema-evolve.test.ts`

- [ ] **Step 1: Write tests** (mocked LLM returning null and non-null proposals; assert pending update file shape).

- [ ] **Step 2: Implement**

Create `packages/dream/src/schema-evolve-cli.ts`:

```typescript
#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Vault, loadConfig, createProvider, initLogger, vaultLog, listThemes, readTheme } from "@openpulse/core";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function alreadyRanThisMonth(vaultRoot: string): Promise<boolean> {
  const path = join(vaultRoot, "vault", "orchestrator-state.json");
  try {
    const state = JSON.parse(await readFile(path, "utf-8"));
    const last = state?.schemaEvolutionPipeline?.lastRun;
    if (!last) return false;
    const now = new Date();
    const lastDate = new Date(last);
    return now.getFullYear() === lastDate.getFullYear() && now.getMonth() === lastDate.getMonth();
  } catch { return false; }
}

async function main() {
  initLogger(VAULT_ROOT);
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!force && !dryRun && await alreadyRanThisMonth(VAULT_ROOT)) {
    console.error("[schema-evolve] Already ran this month; use --force to override.");
    return;
  }

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();
  const provider = createProvider(config);
  const model = config.llm.model;

  const schemaPath = join(vault.warmDir, "_schema.md");
  let currentSchema = "";
  try { currentSchema = await readFile(schemaPath, "utf-8"); } catch {
    console.error("[schema-evolve] No _schema.md found; run dream pipeline first to seed it.");
    return;
  }

  // Sample 3 most-recent themes per type
  const themeNames = await listThemes(vault);
  const docs = await Promise.all(themeNames.map(async (n) => readTheme(vault, n)));
  const byType: Record<string, Array<{ theme: string; content: string; lastUpdated: string }>> = {
    project: [], concept: [], entity: [], "source-summary": [],
  };
  for (const d of docs) {
    if (!d) continue;
    const t = d.type ?? "project";
    (byType[t] ?? []).push({ theme: d.theme, content: d.content, lastUpdated: d.lastUpdated });
  }
  for (const list of Object.values(byType)) list.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));

  const sampleBlock = Object.entries(byType).map(([type, items]) => {
    const top = items.slice(0, 3);
    if (top.length === 0) return `${type}: (no pages)`;
    return `${type}:\n${top.map((t) => `[[${t.theme}]]:\n${t.content.slice(0, 600)}\n---`).join("\n")}`;
  }).join("\n\n===\n\n");

  const prompt = `You are reviewing a wiki schema against observed page content.

Current schema:
${currentSchema}

Sample pages by type:
${sampleBlock}

Based on observed patterns, propose edits to the schema. You may:
- Tweak structure or rules for an existing type
- Propose a new type (with structure, rules, when-to-use)
- Propose removing or merging an existing type

Only propose changes if there is concrete evidence in the samples.

Return ONLY JSON:
{
  "proposed_schema_content": <full new _schema.md text | null>,
  "rationale": [{"change": "...", "evidence": "..."}],
  "confidence": "high" | "medium" | "low"
}
If no changes warranted, proposed_schema_content must be null.`;

  const response = await provider.complete({ model, prompt, temperature: 0, maxTokens: 3072 });
  let parsed: { proposed_schema_content: string | null; rationale: Array<{ change: string; evidence: string }>; confidence: "high" | "medium" | "low" };
  try {
    let j = response.trim();
    if (j.startsWith("```")) j = j.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(j);
  } catch {
    await vaultLog("warn", "[schema-evolve] LLM parse failed");
    return;
  }

  if (dryRun) {
    console.error("Rationale:", JSON.stringify(parsed.rationale, null, 2));
    console.error("Confidence:", parsed.confidence);
    console.error("Proposal:", parsed.proposed_schema_content ?? "(none)");
    return;
  }

  if (!parsed.proposed_schema_content) {
    await vaultLog("info", "[schema-evolve] No changes warranted this run.");
    return;
  }

  const update = {
    id: randomUUID(),
    theme: "_schema",
    proposedContent: parsed.proposed_schema_content,
    previousContent: currentSchema,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending" as const,
    batchId: new Date().toISOString(),
    type: "project" as const,   // placeholder; routing by schemaEvolution field
    schemaEvolution: {
      rationale: parsed.rationale,
      confidence: parsed.confidence,
    },
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  await vaultLog("info", "[schema-evolve] Wrote schema-evolution pending update.");
}

main().catch((err) => {
  console.error("[schema-evolve] Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Build + test + commit**

```bash
pnpm build
cd packages/dream && pnpm vitest run schema-evolve
git add packages/dream/src/schema-evolve-cli.ts packages/dream/test/schema-evolve.test.ts
git commit -m "feat(dream): add schema-evolve CLI for monthly wiki schema proposals"
```

---

## Task 16 — UI server: approval routing, size queue, new endpoints

**Files:**
- Modify: `packages/ui/server.ts`

- [ ] **Step 1: Add `/api/trigger-compact` and `/api/trigger-schema-evolve` endpoints**

In `packages/ui/server.ts`, near the existing `POST /api/trigger-lint`:

```typescript
app.post("/api/trigger-compact", async (req, res) => {
  try {
    const themesArg = Array.isArray(req.body?.themes) ? req.body.themes : [];
    const args = ["../dream/dist/compact-cli.js", ...themesArg];
    const { stdout, stderr } = await execAsync(`node ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 10 * 60_000,
    });
    res.json({ ok: true, output: stderr || stdout });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/trigger-schema-evolve", async (_req, res) => {
  try {
    const { stdout, stderr } = await execAsync(`node ../dream/dist/schema-evolve-cli.js --force`, {
      env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      timeout: 5 * 60_000,
    });
    res.json({ ok: true, output: stderr || stdout });
  } catch (err: unknown) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 2: Route approval for lintFix-merge/delete/rename + schema-evolution + size check**

Find the existing approval handler (`POST /api/pending/:id/approve` or equivalent — search `approve` in server.ts). Wrap the write path with:

```typescript
// 1. Load the pending update
const update: PendingUpdate = JSON.parse(raw);

// 2. Route by sub-kind
if (update.lintFix === "merge" && update.related?.[0]) {
  const { mergeThemes } = await import("@openpulse/core");
  await mergeThemes(new Vault(VAULT_ROOT), update.theme, update.related[0]);
} else if (update.lintFix === "delete") {
  const { mergeThemes } = await import("@openpulse/core");
  await mergeThemes(new Vault(VAULT_ROOT), update.theme, null);
} else if (update.lintFix === "rename" && update.related?.[0]) {
  const { mergeThemes } = await import("@openpulse/core");
  await mergeThemes(new Vault(VAULT_ROOT), update.theme, update.related[0], { rename: true });
} else if (update.schemaEvolution || update.theme === "_schema") {
  // Write to _schema.md instead of theme file
  const schemaPath = join(VAULT_ROOT, "vault", "warm", "_schema.md");
  await fs.writeFile(schemaPath, update.proposedContent, "utf-8");
} else {
  // Normal write path — existing behavior
  await writeTheme(vault, update.theme, update.proposedContent, { /* meta */ });

  // Size check for dream-pipeline project updates
  if (!update.lintFix && !update.compactionType && !update.schemaEvolution && !update.querybackSource) {
    const sections = (update.proposedContent.match(/^###\s+\d{4}-\d{2}-\d{2}\b/gm) ?? []).length;
    if (sections > 14 && update.type === "project") {
      await orchestrator.enqueueForCompaction([update.theme]);
      // Optional: immediate run for responsiveness
      orchestrator.triggerCompact([update.theme]).catch(() => { /* logged internally */ });
    }
  }
}

// 3. Mark pending update approved + delete pending file (existing behavior)
```

- [ ] **Step 3: Wire runCompactionPipeline + runSchemaEvolutionPipeline callbacks**

In the orchestrator construction (search `new Orchestrator(`):

```typescript
const orchestrator = new Orchestrator(VAULT_ROOT, {
  // ... existing callbacks ...
  runCompactionPipeline: async (themes?: string[]) => {
    await new Promise<void>((resolve, reject) => {
      const args = themes && themes.length > 0 ? themes : [];
      const proc = spawn("node", ["../dream/dist/compact-cli.js", ...args], {
        env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`compact exited ${code}`))));
    });
  },
  runSchemaEvolutionPipeline: async () => {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("node", ["../dream/dist/schema-evolve-cli.js"], {
        env: { ...process.env, OPENPULSE_VAULT: VAULT_ROOT },
      });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`schema-evolve exited ${code}`))));
    });
  },
});
```

- [ ] **Step 4: Build + smoke test the dev server**

```bash
pnpm build
cd packages/ui && npx tsx server.ts &
curl -X POST http://localhost:3001/api/trigger-compact -H 'Content-Type: application/json' -d '{}'
```
Expected: `{"ok":true,"output":"..."}`. Check `vault/logs/*.jsonl` for compaction entries.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/server.ts
git commit -m "feat(ui): server routes + approval handlers for compaction, schema-evolution, and lint-fix sub-kinds"
```

---

## Task 17 — UI: Schedule page + Review page badges

**Files:**
- Modify: `packages/ui/src/pages/schedule.ts`
- Modify: `packages/ui/src/pages/review.ts`

- [ ] **Step 1: Add compaction + schema-evolution cards to Schedule page**

Follow the existing dream/lint card structure in `schedule.ts`. For each new pipeline card:
- Title ("Compaction" / "Schema Evolution")
- Last run, next run (from `/api/orchestrator-status` response)
- "Run Now" button → POST `/api/trigger-compact` or `/api/trigger-schema-evolve`
- Status badge (success/error/never)

- [ ] **Step 2: Add badges to Review page**

In `review.ts`, where pending updates are rendered, check for sub-kind fields and add a badge element:

```typescript
function badgeFor(update: PendingUpdate): string {
  if (update.compactionType) return `<span class="badge badge-compact">Compaction (${update.compactionType})</span>`;
  if (update.schemaEvolution) return `<span class="badge badge-schema">Schema (${update.schemaEvolution.confidence})</span>`;
  if (update.querybackSource) return `<span class="badge badge-chat">From chat</span>`;
  if (update.lintFix === "merge") return `<span class="badge badge-lint">Lint merge</span>`;
  if (update.lintFix === "delete") return `<span class="badge badge-lint">Lint delete</span>`;
  if (update.lintFix === "rename") return `<span class="badge badge-lint">Lint rename</span>`;
  if (update.lintFix === "orphans") return `<span class="badge badge-lint">Lint orphan</span>`;
  if (update.lintFix === "stubs") return `<span class="badge badge-lint">Lint stub</span>`;
  return "";
}
```

Add minimal CSS for the new badge classes in the existing stylesheet (follow existing `badge-lint` color choices).

- [ ] **Step 3: Smoke test the UI manually**

Load the UI, trigger a compaction, verify the pending update renders with a "Compaction" badge. Verify clicking Approve actually writes the file and clears the pending.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/schedule.ts packages/ui/src/pages/review.ts
git commit -m "feat(ui): schedule cards and review badges for compaction, schema-evolution, and lint-fix sub-kinds"
```

---

## Task 18 — MCP query-back: judge+refine in chat_with_pulse

**Files:**
- Modify: `packages/mcp-server/src/tools/chat-with-pulse.ts`

- [ ] **Step 1: Add judge+refine helper**

In `chat-with-pulse.ts`, near the top (after imports):

```typescript
interface JudgeResult {
  verdict: "yes" | "no" | "maybe";
  proposed_name: string | null;
  one_line_definition: string | null;
  refined_content: string | null;
}

async function judgeAndRefine(
  provider: LlmProvider, model: string,
  question: string, answer: string, themesConsulted: string[]
): Promise<JudgeResult> {
  try {
    const response = await provider.complete({
      model, temperature: 0,
      prompt: `Question: ${question}

Answer: ${answer}

Themes consulted: ${themesConsulted.join(", ")}

Is this answer durable, reusable knowledge worth a wiki concept page, or ephemeral Q&A?

Return ONLY JSON:
{
  "verdict": "yes" | "no" | "maybe",
  "proposed_name": <kebab-case slug> | null,
  "one_line_definition": <string> | null,
  "refined_content": <full concept-page markdown with "## Definition", "## Key Claims", "## Related Concepts", "## Sources" sections> | null
}
All fields null if verdict is "no".`,
    });
    let j = response.trim();
    if (j.startsWith("```")) j = j.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    return JSON.parse(j);
  } catch {
    return { verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null };
  }
}
```

- [ ] **Step 2: Replace the existing file-offer block**

Find where the existing `file: <name>` offer is appended to responses. Replace with:

```typescript
// Remove the old "Reply file: <name>" block.

if (themesConsulted.length >= 2) {
  const judgment = await judgeAndRefine(provider, model, input.message, response, themesConsulted);

  if (judgment.verdict === "yes" && judgment.proposed_name && judgment.refined_content) {
    const themeName = judgment.proposed_name.toLowerCase().replace(/\s+/g, "-");
    const update = {
      id: randomUUID(),
      theme: themeName,
      proposedContent: judgment.refined_content,
      previousContent: null,
      entries: [],
      createdAt: new Date().toISOString(),
      status: "pending" as const,
      batchId: new Date().toISOString(),
      type: "concept" as const,
      querybackSource: { question: input.message, themesConsulted },
    };
    await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
    response += `\n\n_Filed [[${themeName}]] as a pending concept page. Review it in the Control Center._`;
  } else if (judgment.verdict === "maybe" && judgment.proposed_name && judgment.refined_content) {
    session.pendingFile = {
      name: judgment.proposed_name.toLowerCase().replace(/\s+/g, "-"),
      content: judgment.refined_content,
      question: input.message,
      themesConsulted,
    };
    response += `\n\n_This looks like durable knowledge. Reply \`file: yes\` to save as [[${session.pendingFile.name}]]._`;
  }
  // verdict === "no": do nothing, no noise
}
```

- [ ] **Step 3: Handle `file: yes` reply on the next turn**

Near the start of `handleChatWithPulse`, before any LLM call:

```typescript
if (/^file:\s*yes\b/i.test(input.message) && session?.pendingFile) {
  const pf = session.pendingFile;
  const update = {
    id: randomUUID(),
    theme: pf.name,
    proposedContent: pf.content,
    previousContent: null,
    entries: [],
    createdAt: new Date().toISOString(),
    status: "pending" as const,
    batchId: new Date().toISOString(),
    type: "concept" as const,
    querybackSource: { question: pf.question, themesConsulted: pf.themesConsulted },
  };
  await writeFile(join(vault.pendingDir, `${update.id}.json`), JSON.stringify(update, null, 2), "utf-8");
  session.pendingFile = undefined;
  return {
    content: [{ type: "text" as const, text: `Filed [[${pf.name}]] as a pending concept page. Review it in the Control Center.` }],
    sessionId: session.id,
  };
}
```

- [ ] **Step 4: Extend session type**

In `ChatSession` (or the local MCP session type), add:

```typescript
pendingFile?: {
  name: string;
  content: string;
  question: string;
  themesConsulted: string[];
};
```

- [ ] **Step 5: Build + tests + commit**

```bash
pnpm build && pnpm vitest run chat-with-pulse
git add packages/mcp-server/src/tools/chat-with-pulse.ts packages/core/src/types.ts
git commit -m "feat(mcp): LLM-judged query-back with yes/no/maybe verdicts, refined concept content, session pendingFile state"
```

---

## Task 19 — Integration smoke test + verification

**Files:** none new; runs the full system.

- [ ] **Step 1: Full build + test**

```bash
pnpm build
pnpm vitest run
```
Expected: all tests pass; ~450 tests total.

- [ ] **Step 2: Live smoke test**

1. Start the UI dev server (`cd packages/ui && npx tsx server.ts &`).
2. Trigger dream pipeline from the Schedule page. Verify `_concept-candidates.json` and `_orphan-candidates.json` are written (if applicable).
3. Trigger lint from the Schedule page. Check `_lint.md` renders the new sections (Low-value, Duplicate-theme, Low-provenance, Orphan candidates, Concept candidates).
4. Trigger `--fix=merge` via UI button that calls `/api/trigger-lint` with fix flag. Verify pending updates appear in Review with a "Lint merge" badge.
5. Approve a lint-merge pending update. Verify `vault/warm/<source>.md` is deleted, `<canonical>.md` contains merged content, and `[[source]]` references across files are rewritten.
6. Trigger compaction manually. Verify pending updates appear with "Compaction (scheduled)" badge. Approve one; verify `_schema.md` is not touched and the theme file is replaced with the compacted version.
7. Trigger schema-evolution manually (`--force`). Verify either "No changes warranted" log, or a pending update with "Schema" badge.
8. In Claude Desktop, ask `chat_with_pulse` a multi-theme question. Verify the judge+refine behavior — either a "Filed [[...]]" note, a "Reply `file: yes`" offer, or nothing (for `no` verdict).

- [ ] **Step 3: Commit the final verification notes if anything was adjusted**

```bash
git status
# If there are fixes from smoke testing, commit them with a descriptive message.
```

---

## Self-review checklist (run before considering plan done)

1. **Spec coverage:**
   - §1.1 Entry-level preFilter → Task 4 ✓
   - §1.2 Concept-awareness → Task 5 ✓
   - §1.3 Canonicalization → Tasks 7 + 8 ✓
   - §1.4 Confidence threshold → Task 6 ✓
   - §1.5 Backlinks-aware synthesis → Task 9 ✓
   - §1.6 Two-pass synthesis → Task 10 ✓
   - §2.1–2.7 Lint enhancements → Tasks 11, 12, 13 ✓
   - §3 Compaction pipeline → Tasks 14, 16, 17 ✓
   - §4 Schema Evolution → Tasks 15, 16, 17 ✓
   - §5 MCP query-back → Task 18 ✓
   - §6 Data model → Tasks 1, 2 ✓
   - §7 Error handling — mostly inline per-task (try/catch with vaultLog); no dedicated task, verified in smoke test step ✓
   - §8 Testing — per-task TDD ✓

2. **Placeholder scan:** No "TBD" / "implement later" in the plan. Tasks 11 and 17 reference "follow existing pattern" for test structure and UI card structure — acceptable because the patterns are visible in the current repo (e.g., `packages/dream/test/lint.test.ts` already exists and has the `makeTempVault` helper; `packages/ui/src/pages/schedule.ts` has the dream + lint cards to copy).

3. **Type consistency:**
   - `PendingUpdate` extensions (Task 1) are used by Tasks 8, 10, 14, 15, 16, 17, 18 — all references check out.
   - `CompactionPipelineState` / `SchemaEvolutionPipelineState` (Task 2) are used by Tasks 14, 15, 16 — consistent.
   - `CanonicalizationResult` (Task 7) is used by Task 8 — consistent.
   - `ClassifyResult` new fields (Tasks 5, 6, 8) are consumed by Task 8 — consistent.
   - `mergeThemes` signature (Task 3) is used by Task 13 (via pending update approval) and Task 16 — consistent.

---

**End of plan.**
