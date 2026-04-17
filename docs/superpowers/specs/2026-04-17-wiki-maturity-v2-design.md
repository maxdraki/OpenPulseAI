# Wiki Maturity v2 — Design

**Date:** 2026-04-17
**Status:** Design (pending user approval)
**Supersedes (extends):** `2026-04-16-wiki-maturity.md` (Tier 1 implemented, this spec is v2)

## Goal

Evolve the dream pipeline from a grouped activity feed into a self-maintaining, compounding wiki — the pattern described in Karpathy's *LLM Wiki* gist (raw sources → LLM-maintained wiki → schema, with ingest / query / lint operations). The v1 implementation delivered types, provenance, backlinks, lint, and a file-this-answer loop, but post-ship review of actual vault output surfaced concrete gaps: theme fragmentation, legacy garbage themes, "no activity" padding, zero concept pages, weak cross-linking, unbounded Activity Log, and no consolidation mechanism.

This spec addresses those gaps by:

1. Tightening the existing Dream and Lint pipelines with hygiene and concept-awareness
2. Adding two new pipelines (Compaction, Schema Evolution) for jobs Dream shouldn't do
3. Flipping the MCP query-back loop from user-initiated to LLM-judged

## Context: observations that motivate this work

Review of `~/OpenPulseAI/vault/warm/` on 2026-04-17 found:

- `openpulse.md` and `openpulseai.md` exist as separate themes for the same project (theme fragmentation).
- `closed.md` and `documents.md` exist despite being on the stopword list — they predate the guard and nothing cleans them up.
- `_backlinks.md` references `[[mcp]]` but there is no `mcp.md` file (broken link lint didn't catch it because the backlinks file is built from inbound references).
- `openpulse.md` contains large blocks of "No activity recorded" listing silent repos.
- All 9 themes are `type: project`; zero concept pages have ever been created. `inferType` returns `project` for almost everything.
- 5 of 9 themes have no inbound links. The wiki is a star graph, not a web.
- `Current Status` on every page is a paraphrase of the most recent Activity Log entry, not a compounding durable statement.
- `project` pages have unbounded Activity Log growth with no consolidation mechanism.

Provenance markers (`^[src:]`) and the rollup into `sources` frontmatter — both shipped in v1 — are working well. Those are preserved.

## Design decisions

All decisions below were made during brainstorming and are load-bearing for this spec.

1. **Scope:** All tiers in a single plan. No sequencing into smaller ships.
2. **Theme canonicalization:** Hybrid — deterministic (lowercase/kebab, Levenshtein ≤ 2, prefix ≥ 6) first; single batched LLM call as fallback when new themes survive the deterministic pass. Auto-merge on exact-after-normalization; propose pending update on fuzzy/LLM-flagged matches.
3. **Compaction trigger:** Both — size-triggered inline in Dream (after synthesis, if Activity Log > 14 dated sections) + scheduled monthly with 7-day per-theme dedup.
4. **Compaction output:** Always a pending update. Optional cold-storage snapshot of pre-compaction content on approval.
5. **Query-back policy:** LLM-judged with three verdicts (`yes` → auto-create pending, `maybe` → inline prompt for `file: yes`, `no` → drop). Content is LLM-refined into concept-page shape, not verbatim answer.
6. **Two-pass synthesis:** Scoped to `concept` and `entity` page types only. `project` and `source-summary` continue to use single-pass synthesis. Implementation sequenced as the last task in Dream so it can be cut under scope pressure.
7. **New-theme confidence threshold:** `0.5`. Entries below this threshold are deferred to an orphan-candidate queue, surfaced by lint for user approval.
8. **Schema evolution:** Monthly cadence, pending update for human approval, proposed as a full new `_schema.md` with rationale.
9. **Fact store (for two-pass):** Per-theme JSONL sidecars at `vault/warm/_facts/<theme>.jsonl`, append-only.
10. **User prior on query-back:** Filing concept pages from chat is expected to be rare in practice. The feature should be cheap-to-skip (gate returns early when < 2 themes consulted) and not over-engineered.

## Architecture

Four pipelines + one cross-cutting change. Each has distinct cadence, intent, and write path.

```
        ┌──────────────────────────────────────────────────┐
        │            vault/hot/ (raw journals)             │
        └───────────┬──────────────────────────────────────┘
                    │ daily
                    ▼
          ┌──────────────────────┐          ┌──────────────────────────┐
          │    Dream Pipeline    │──writes─▶│ vault/warm/_pending/*.json│
          │  classify→synthesize │          └──────────────────────────┘
          │  + canonicalize      │                        │
          │  + size-trigger→Compact                       │ user approves
          └──────────────────────┘                        ▼
                                                ┌──────────────────────┐
                                                │ vault/warm/<theme>.md│
                                                └──────────────────────┘
                                                          ▲
  Compaction Pipeline     ──┐                             │
  (monthly + size-trig)     │                             │
                            │                             │
  Lint Pipeline           ──┼── all write pending ────────┤
  (weekly, read-only)       │                             │
                            │                             │
  Schema Evolution        ──┤                             │
  (monthly)                 │                             │
                            │                             │
  MCP query-back          ──┘                             │
  (on chat_with_pulse)                                    │
```

**Invariant:** no pipeline writes directly to warm. All state mutations of warm pass through the pending-update queue. Humans stay in the loop.

**Orchestrator state** extends with `compactionPipeline` and `schemaEvolutionPipeline` sub-states. All four pipelines share the `Schedule` + cron + callback pattern established by dream and lint.

**New pipeline CLIs** in `packages/dream/src/`:
- `compact-cli.ts` → `openpulse-compact` binary
- `schema-evolve-cli.ts` → `openpulse-schema-evolve` binary

## §1 — Dream pipeline enhancements

Six changes, in order of execution within a dream run.

### 1.1 Entry-level preFilter

Current `preFilter` in `packages/dream/src/classify.ts` strips lines matching `ABSENCE_LINE` patterns. New rule added to `preFilter`: after line-stripping and orphan-heading removal, count lines where the existing `isSubstantive` helper returns true. If fewer than **5 substantive lines** remain AND the entry contains no commit/PR/issue/change tokens (regex: `/(modified|changed|added|created|updated|committed|pushed|merged|commit|PR|pull|issue|#\d+)/i`), drop the whole entry by returning `null`.

`closed.md` exists because such fragments survived. This closes that path.

### 1.2 Classifier concept-awareness

The deterministic classifier (file paths, repo names, headings) is unchanged. The LLM fallback prompt in `classifyEntries` is extended to request `concept_candidates` alongside `themes` and `type`:

```
Respond with ONLY a JSON array:
[{
  "index": 0,
  "themes": ["project-name"],
  "type": "project",
  "concept_candidates": ["barrier-pattern", "wiki-maturity"]
}]
```

`concept_candidates` are not created as pages. They are accumulated into `vault/warm/_concept-candidates.json`:

```json
{
  "barrier-pattern": { "count": 5, "sources": ["2026-04-16-github-activity", ...], "firstSeen": "..." },
  ...
}
```

Counts are incremented across dream runs. Lint (§2.5) surfaces candidates with `count ≥ 3`.

### 1.3 Canonicalization (hybrid)

New module `packages/dream/src/canonicalize.ts`.

**Entrypoint:** `canonicalizeThemes(proposed: string[], existing: string[], provider, model): Promise<CanonicalizationResult>`

```ts
interface CanonicalizationResult {
  redirects: Record<string, string>;  // proposed → canonical (auto-merge, silent)
  proposals: Array<{                   // proposed pending merges (user approves)
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}
```

**Exported helpers:** the deterministic pass is exported as a standalone function for reuse by lint (§2.2):

```ts
export function normalizeThemeName(name: string): string;
export function findFuzzyMatches(names: string[]): Array<{ a: string; b: string; reason: "levenshtein" | "prefix" }>;
```

**Algorithm:**

1. **Normalize:** lowercase, replace non-alphanumeric with `-`, collapse repeats, trim leading/trailing `-`. (No plural stripping — `bug` and `bugs` may be semantically distinct themes.)
2. **Exact-match pass:** for each proposed name, if `normalizeThemeName(proposed)` exactly matches `normalizeThemeName(existing)`, add to `redirects` silently.
3. **Fuzzy pass:** for remaining proposed names, pairwise compare against existing. If Levenshtein ≤ 2 OR a shared prefix ≥ 6 characters, add to `proposals` with `reason: "levenshtein"` or `reason: "prefix"`.
4. **LLM pass (only if new themes survived steps 2–3):** single batched call:
   ```
   Do any of these proposed themes refer to the same thing as any existing theme?
   Proposed: {list}
   Existing: {list}
   Return JSON: [{"proposed": "...", "canonical": "..." | null}]
   ```
   Non-null canonicals are added to `proposals` with `reason: "llm"`.

**Integration:** called from `classifyEntries` in `classify.ts` after deterministic + LLM passes produce raw themes. `redirects` are applied silently to `classified` entries (theme names rewritten). `proposals` are propagated into `ClassifyResult.themeMergeProposals` (§6.3), and `packages/dream/src/index.ts` converts each proposal into a pending update with `lintFix: "merge"` for user approval.

### 1.4 Confidence threshold on new-theme creation

`ClassificationResult.confidence` is already returned. New rule in `classify.ts`: if `confidence < 0.5` AND none of `result.themes` are in the existing-themes set, defer the entry to an orphan-candidate entry in `ClassifyResult.orphanCandidates` instead of passing it to synthesis. The entry is *not* synthesized this run.

Persistence to `vault/warm/_orphan-candidates.json` happens in `index.ts` after classification. Format:

```json
[
  {
    "entryTimestamp": "2026-04-17T08:54:47.200Z",
    "source": "folder-watcher",
    "log": "...",
    "proposedThemes": ["data-platform-2026"],
    "confidence": 0.35,
    "deferredAt": "2026-04-17T10:00:00.000Z"
  }
]
```

Lint (§2.4) surfaces these. On `--fix=orphans`, lint creates pending updates with `lintFix: "orphan"` — user approval creates the theme and re-runs synthesis for that entry on next dream.

### 1.5 Backlinks-aware synthesis prompt

In `packages/dream/src/synthesize.ts`, before the `provider.complete` call for each theme, load:
- Inbound links for this theme (from a fresh `buildBacklinks(vault)` call, or by reading `_backlinks.md` if present and < 24h old)
- Themes that share any `sources` frontmatter entries with this theme (via `readTheme` on the candidate set)

Prompt addition:

```
Context for cross-references:
- This theme is linked from: [[a]], [[b]]
- Themes that share sources with this one: [[c]], [[d]]
When your update mentions content related to these themes, add [[wiki-links]].
```

Low-risk prompt change. Expected effect: noticeable increase in link density across future synthesis.

### 1.6 Two-pass synthesis for concept / entity only

In `synthesize.ts`, branch on `pageType`:

- `project`, `source-summary` → existing single-pass synthesis (unchanged).
- `concept`, `entity` → two-pass:

**Pass 1 (per entry in this theme's batch):** LLM extracts atomic facts.

```
Extract atomic factual claims from this entry relevant to the theme "{theme}".
Each claim must be one sentence, self-contained, and cite its source.
Return JSON: [{"claim": "...", "sourceId": "{entry-id}", "confidence": "high"|"medium"|"low"}]
```

Each returned fact is appended as one line to `vault/warm/_facts/<theme>.jsonl`:

```
{"claim": "...", "sourceId": "2026-04-16-github-activity", "confidence": "high", "extractedAt": "2026-04-17T..."}
```

**Pass 2 (per theme):** read existing page content + entire fact store for this theme. Prompt:

```
You are maintaining a {pageType} page for "{theme}".
Existing content: {existing}
Facts (with sources): {facts_jsonl_formatted}
Structure: {template.structure}
Rules: {template.rules}

Hard constraints:
- You may only make claims that appear in the facts list above.
- Every claim must include its ^[src:sourceId] citation.
- If facts conflict, prefer the most recent (by extractedAt) but note the conflict with ^[ambiguous].

Return ONLY the Markdown content.
```

Rationale for the project vs. concept split: project pages are append-mostly chronological; fact extraction adds overhead without synthesis benefit. Concept and entity pages merge information across many sources over time, which is where structured facts pay off.

**Fact store lifecycle:** append-only during extraction; read-only during pass 2; deleted when the theme is deleted (via `mergeThemes`); re-consulted during compaction (§3.3).

## §2 — Lint pipeline enhancements

Six additions. Lint stays read-only by default; `--fix` flags produce pending updates.

### 2.1 Low-value page detection

New structural issue type `low-value` in `packages/dream/src/lint-structural.ts`. A theme is flagged if:
- Content (excluding frontmatter) < 250 characters, OR
- All `^[src:]` markers reference the same single source ID AND page has ≤ 3 bullets

Fix: `--fix=delete-lowvalue` creates pending updates with `lintFix: "delete"`. Approval triggers file deletion via `mergeThemes` (with `rename: false`, `canonical: null` mode — a pure delete path).

### 2.2 Near-duplicate theme detection

New structural issue type `duplicate-theme`. Reuses the deterministic pass from `canonicalize.ts`:

```ts
import { findFuzzyMatches } from "./canonicalize.js";

const pairs = findFuzzyMatches(allThemeNames);
// returns Array<{ a, b, reason }> where reason in "levenshtein" | "prefix"
```

On `--deep` flag, an optional batched LLM call confirms/rejects each pair.

Fix: `--fix=merge` creates pending updates with `lintFix: "merge"` containing both theme names. Approval runs `mergeThemes(source, canonical)`.

### 2.3 Provenance coverage metric

New structural issue type `low-provenance`. For each theme:

```ts
const paragraphs = content.split(/\n\n+/).filter(p => {
  const t = p.trim();
  return t && !t.startsWith("#") && !t.startsWith("- ") && !t.startsWith("* ");
});
const withProvenance = paragraphs.filter(p => /\^\[src:/.test(p)).length;
const coverage = paragraphs.length > 0 ? withProvenance / paragraphs.length : 1;
```

Flagged if `coverage < 0.7`. Detail: `"12 of 18 paragraphs have provenance (67%)"`.

No `--fix` action. This is a signal to tighten the synthesis prompt or reject weak pending updates manually.

### 2.4 Orphan-candidate surfacing

Read `vault/warm/_orphan-candidates.json` (written by §1.4). Render in `_lint.md`:

```
## Orphan candidates (7)
Entries deferred because classifier confidence < 0.5:

- 2026-04-16 folder-watcher — "Data Platform 2026.pptx" (proposed: "data-platform-2026", conf 0.35)
- ...

Run `openpulse-lint --fix=orphans` to review and approve.
```

Fix: `--fix=orphans` creates one pending update per candidate with `lintFix: "orphan"`. User approves individually in the UI; approval creates the theme on next dream run.

### 2.5 Concept-candidate surfacing

Read `vault/warm/_concept-candidates.json` (written by §1.2). Filter to candidates with `count ≥ 3`. Render:

```
## Concept candidates (4)
Terms appearing across ≥3 entries with no page yet:

- "barrier-pattern" (5 mentions) — seen in [[dream]], [[openpulseai]], ...
- ...
```

Fix: existing `--fix=stubs` extended to include these candidates alongside semantic stub suggestions.

### 2.6 New `--fix=rename` action

Operates on a single theme specified by name. CLI prompts for a new slug or takes it as argument: `openpulse-lint --fix=rename --from=openpulse --to=openpulseai`. Creates a pending update with `lintFix: "rename"`. Approval runs `mergeThemes(from, to, { rename: true })`.

### 2.7 Report structure

`_lint.md` sections in order:

1. Existing: Broken links, Orphan themes, Schema compliance, Stale themes, Duplicate-date sections
2. New: **Low-value pages** (§2.1)
3. New: **Duplicate themes** (§2.2)
4. New: **Low provenance** (§2.3)
5. New: **Orphan candidates** (§2.4)
6. New: **Concept candidates** (§2.5)
7. Existing: Contradictions
8. Actions footer (updated with new `--fix` commands)

## §3 — Compaction pipeline (new)

### 3.1 Triggers

**Size trigger (post-approval).** When a pending dream update is approved, the approval handler (in `packages/ui/server.ts`) checks whether the newly-written theme file contains > 14 dated sections AND is `type: project`. If so, it appends the theme name to `compactionPipeline.sizeQueue: string[]` in orchestrator state. The queue is drained by the next compaction run — either the next scheduled run, or by explicit invocation via `runCompactionPipeline(queuedThemes)` which the approval handler may call immediately for responsiveness.

Rationale for post-approval (rather than inside dream): dream writes only pending updates. Warm files don't change until approval. A size check against pending content could enqueue compaction on updates the user ultimately rejects; a size check against warm reflects committed state.

**Scheduled trigger.** Monthly cron with default `0 4 1 * *`. Compacts every theme, skipping any where `perThemeLastCompacted[theme]` is within the last 7 days.

### 3.2 Project-page compaction

```
1. Read theme file, parse into frontmatter + Current Status + Activity Log
2. Split Activity Log by ### YYYY-MM-DD headings
3. Partition:
   - verbatim: last 14 sections (most recent first)
   - older: the rest, grouped by ISO week (YYYY-Www)
4. LLM call:
   "Current page: {page}
    Older sections grouped by week: {grouped}
    Produce:
    (a) Rewritten ## Current Status reflecting the project's trajectory (not just the most recent entry).
    (b) ## History section: one bullet per ISO week summarising key events,
        preserving ^[src:] markers from source entries.
    Return JSON: {current_status: '...', history: '...'}"
5. Assemble new content: frontmatter + new Current Status + ## Activity Log (14 verbatim sections) + ## History (weekly summarised older content)
6. Write pending update:
   {
     id, theme, proposedContent, previousContent,
     entries: [],
     type: "project",
     compactionType: "scheduled" | "size",
     batchId
   }
```

### 3.3 Concept / entity page compaction

For non-project page types, Activity Log doesn't apply. Compaction re-synthesises from the fact store:

```
1. Read page + _facts/<theme>.jsonl
2. LLM call:
   "Page: {page}
    Facts (with sources, includes older and newer): {facts}
    Rewrite the page. Prefer newer facts where they contradict older ones.
    Preserve all source citations. Note unresolved conflicts with ^[ambiguous]."
3. Pending update with compactionType = "scheduled" (no size-trigger path for these types)
```

### 3.4 State and CLI

```ts
interface CompactionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
  perThemeLastCompacted: Record<string, string>;  // ISO timestamps
  sizeQueue: string[];                             // themes awaiting size-triggered compaction
}
```

`openpulse-compact` modes:
- `openpulse-compact` → scheduled mode: drain `sizeQueue` first (no skip check), then compact all themes respecting 7-day skip. Writes `perThemeLastCompacted` on success.
- `openpulse-compact theme1 theme2` → explicit themes, no skip check, still writes `perThemeLastCompacted`. Used by the approval handler's immediate invocation path.
- `openpulse-compact --force` → scheduled mode ignoring 7-day skip.

### 3.5 Pending-update approval safety

On approval of a compaction pending update, `writeTheme` replaces the file as usual. If the orchestrator setting `archiveBeforeCompact` is enabled (default true), the pre-compaction content is snapshotted to `vault/cold/compactions/YYYY-MM-DD-<theme>.md` before the replacement. This provides forensic recovery if compaction loses something important.

### 3.6 UI

Schedule page: new Compaction card, same shape as Dream/Lint cards (last run, next run, Run Now button, result).
Review page: pending updates with `compactionType` set render with a "Compaction" badge and a clear diff view (previous vs. proposed).

## §4 — Schema Evolution pipeline (new)

### 4.1 Trigger

Scheduled only. Default cron `0 5 1 * *` (05:00 on the 1st, one hour after compaction). No size trigger.

### 4.2 Algorithm

```
1. Read current _schema.md (raw text, not parsed — schema may include future types the parser doesn't know)
2. Group all themes by type; sample 3 most-recently-updated themes per type
3. LLM call:
   "Current wiki schema: {raw_schema}
    Sample pages:
    project: {3 pages}
    concept: {3 pages or 'none'}
    entity: ...
    source-summary: ...

    Based on observed patterns, propose edits to the schema. You may:
    - Tweak structure or rules for an existing type
    - Propose a new type (with structure, rules, when-to-use)
    - Propose removing or merging an existing type

    Only propose changes if you see concrete evidence in the samples.

    Return JSON:
    {
      proposed_schema_content: <full new _schema.md text | null>,
      rationale: [{change: '...', evidence: '...'}],
      confidence: 'high' | 'medium' | 'low'
    }
    If no changes warranted, proposed_schema_content must be null."
4. If proposed_schema_content is non-null, write pending update:
   {
     id: uuid,
     theme: "_schema",
     proposedContent: <new>,
     previousContent: <old>,
     entries: [],
     type: "project",    // placeholder — actual routing is via schemaEvolution field
     schemaEvolution: { rationale, confidence },
     status: "pending",
     batchId: <ISO>
   }
```

### 4.3 Approval path

Pending updates with `schemaEvolution` set (or `theme === "_schema"`) route to writing `vault/warm/_schema.md` instead of `vault/warm/<theme>.md`. The approval handler in the UI checks for this field and routes accordingly.

### 4.4 State and CLI

```ts
interface SchemaEvolutionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
}
```

`openpulse-schema-evolve` modes:
- `openpulse-schema-evolve` → run and write pending update if non-null proposal.
- `openpulse-schema-evolve --dry-run` → write rationale to stdout, no pending update.

### 4.5 UI

Schedule page: new Schema Evolution card.
Review page: pending updates with `schemaEvolution` render with a "Schema" badge, a diff view of the old vs. new schema, and the rationale bullets inline.
Settings page: toggle to disable schema evolution entirely (default on).

## §5 — MCP query-back

### 5.1 Flow

In `packages/mcp-server/src/tools/chat-with-pulse.ts`, after generating the assistant response:

```
if (themesConsulted.length < 2) {
  return response;  // no judge call, no noise
}

const judgeResult = await provider.complete({
  model,
  temperature: 0,
  prompt: `Question: {question}
    Answer: {answer}
    Themes consulted: {list}

    Is this answer durable, reusable knowledge worth a wiki concept page,
    or ephemeral Q&A?

    Return JSON:
    {
      verdict: 'yes' | 'no' | 'maybe',
      proposed_name: kebab-case slug | null,
      one_line_definition: string | null,
      refined_content: <concept-page markdown with Definition / Key Claims / Related Concepts / Sources> | null
    }
    All fields null if verdict is 'no'.`
});

const judgment = parseJudgment(judgeResult);  // defensive: treat malformed as 'no'

if (judgment.verdict === 'no') return response;

if (judgment.verdict === 'yes') {
  await createPendingUpdate({
    theme: judgment.proposed_name,
    proposedContent: judgment.refined_content,
    type: "concept",
    querybackSource: { question, themesConsulted },
  });
  return response + "\n\n_Filed [[" + judgment.proposed_name + "]] as a pending concept page. Review in the Control Center._";
}

// verdict === 'maybe'
session.pendingFile = { token: short(), name: judgment.proposed_name, content: judgment.refined_content };
return response + "\n\n_This looks like a concept worth saving. Reply `file: yes` to save as [[" + judgment.proposed_name + "]]._";
```

On the next turn, if the user message matches `/^file: yes\b/i` and `session.pendingFile` is set, create the pending update using the stored content and clear `session.pendingFile`.

### 5.2 Retire the old `file: <name>` path

The existing "reply `file: <name>`" affordance is removed. Keeping both would create two ways to do the same thing with different semantics.

### 5.3 Cost

Zero cost on turns with < 2 themes consulted (gate returns early). One extra LLM call per multi-theme turn. Given the prior that concept pages from chat will rarely fire, this is acceptable; the `no` verdict path is fast and produces no UI spam.

## §6 — Data model changes

### 6.1 `packages/core/src/types.ts`

```ts
// PendingUpdate — extend with new optional sub-kind fields
interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: ActivityEntry[];
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "edited";
  batchId?: string;
  type?: ThemeType;

  // Sub-kind fields (at most one is set)
  lintFix?: "stubs" | "orphans" | "merge" | "delete" | "rename";  // "merge"/"delete"/"rename" are new
  compactionType?: "scheduled" | "size";                           // NEW
  schemaEvolution?: {                                              // NEW
    rationale: Array<{ change: string; evidence: string }>;
    confidence: "high" | "medium" | "low";
  };
  querybackSource?: {                                              // NEW
    question: string;
    themesConsulted: string[];
  };

  // Existing optional fields
  sources?: string[];
  related?: string[];
  created?: string;
}
```

### 6.2 `packages/core/src/orchestrator.ts`

```ts
interface CompactionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
  perThemeLastCompacted: Record<string, string>;
  sizeQueue: string[];
}

interface SchemaEvolutionPipelineState {
  running: boolean;
  lastRun: string | null;
  lastResult: "success" | "error" | "never";
  lastError?: string;
  schedule: Schedule;
}

interface OrchestratorState {
  lastHeartbeat: string | null;
  collectors: Record<string, CollectorState>;
  dreamPipeline: DreamPipelineState;
  lintPipeline: LintPipelineState;
  compactionPipeline: CompactionPipelineState;        // NEW
  schemaEvolutionPipeline: SchemaEvolutionPipelineState;  // NEW
}

interface OrchestratorCallbacks {
  runCollector(skillName: string): Promise<void>;
  runDreamPipeline(): Promise<void>;
  runLintPipeline(): Promise<void>;
  runCompactionPipeline(themes?: string[]): Promise<void>;  // NEW
  runSchemaEvolutionPipeline(): Promise<void>;              // NEW
  getSkillNames(): Promise<string[]>;
}
```

### 6.3 `packages/dream/src/classify.ts`

```ts
interface ClassifyResult {
  classified: ClassificationResult[];
  proposedTypes: Record<string, ThemeType>;
  conceptCandidates: Record<string, { count: number; sources: string[]; firstSeen: string }>;  // NEW
  orphanCandidates: Array<{                                                                     // NEW
    entryTimestamp: string;
    source?: string;
    log: string;
    proposedThemes: string[];
    confidence: number;
    deferredAt: string;
  }>;
  themeMergeProposals: Array<{                                                                  // NEW
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}
```

`packages/dream/src/index.ts` is responsible for persisting `conceptCandidates` and `orphanCandidates` to their JSON sidecars (merging with existing content), and for creating `theme-merge` pending updates from `themeMergeProposals`.

### 6.4 New vault artifacts

| Path | Format | Written by | Read by |
|---|---|---|---|
| `vault/warm/_concept-candidates.json` | JSON object (term → {count, sources, firstSeen}) | classify (§1.2) | lint (§2.5) |
| `vault/warm/_orphan-candidates.json` | JSON array | classify (§1.4) | lint (§2.4), dream on approval |
| `vault/warm/_facts/<theme>.jsonl` | JSONL, append-only | synthesize pass 1 (§1.6) | synthesize pass 2 (§1.6), compact (§3.3) |
| `vault/cold/compactions/<date>-<theme>.md` | Markdown | compact approval (§3.5) | manual recovery |

### 6.5 Shared utility module

`packages/core/src/merge-themes.ts`:

```ts
export async function mergeThemes(
  vault: Vault,
  source: string,
  canonical: string | null,       // null = delete source, no merge
  opts?: { rename?: boolean }     // rename: content moves whole (no interleave)
): Promise<void>;
```

Behaviour:
1. If canonical is non-null: rewrite all `[[source]]` references to `[[canonical]]` across every file in `vault/warm/*.md`.
2. If canonical is non-null: append source content into canonical content (prepend as `### Merged from [[source]] on YYYY-MM-DD` for projects; interleave facts for concepts).
3. If `_facts/source.jsonl` exists and canonical is non-null: append its contents to `_facts/canonical.jsonl`.
4. Delete `vault/warm/source.md` and `vault/warm/_facts/source.jsonl` if present.
5. Regenerate `_backlinks.md`.

Idempotent: each sub-step checks state before acting. A retry after partial failure completes what's missing.

### 6.6 Backward compatibility

All new fields are optional. Existing pending updates and state files deserialize unchanged. First run after upgrade:
- `loadOrchestratorState` fills in defaults for `compactionPipeline` and `schemaEvolutionPipeline`.
- Existing pending updates without any sub-kind field behave as normal dream updates.
- `_concept-candidates.json`, `_orphan-candidates.json` are read as `{}` / `[]` when absent.

## §7 — Error handling

**Philosophy:** pipelines are atomic at the theme level. One theme failing does not block others. No pipeline writes directly to warm; pending-update queue is the commit boundary.

| Failure | Handling |
|---|---|
| Classifier LLM invalid JSON | Fall back to `source ?? "uncategorized"`; log warn. |
| Canonicalization LLM call fails | Proceed with deterministic pass only; log warn. |
| Fact-extraction pass 1 fails for an entry (concept/entity) | Skip that entry for fact extraction; still pass through to a single-pass synthesis fallback for this theme; log warn. |
| Pass 2 synthesis fails | Pending update not created for this theme; other themes unaffected; hot files NOT archived (preserves retry). |
| Compaction LLM fails | No pending update; theme skipped this run; `perThemeLastCompacted` NOT updated → next scheduled run retries. |
| Schema evolution LLM fails | No pending update; log warn; next monthly run retries. |
| MCP query-back judge malformed JSON | Treat as `verdict: 'no'`; return response unchanged; no spam. |
| `mergeThemes` partial failure | Each sub-step idempotent; approval retry completes remaining steps. |

Every catch block logs via `vaultLog("warn"|"error", ...)` with enough context to diagnose from `vault/logs/*.jsonl`.

## §8 — Testing

Unit and integration tests live next to the code. LLM calls mocked with `vi.fn()`. Real filesystem via `mkdtemp` for integration.

| File | Coverage | New tests |
|---|---|---|
| `canonicalize.test.ts` (new) | Normalization, Levenshtein, prefix, LLM pass, redirect vs. propose paths | ~15 |
| `classify.test.ts` (extend) | Entry-level preFilter, concept candidates, confidence threshold routing | ~10 |
| `synthesize.test.ts` (extend) | Two-pass fires for concept/entity only, fact store append/read, backlink-aware prompt | ~8 |
| `compact.test.ts` (new) | Bucketing logic, project vs. concept paths, pending update shape, 7-day skip | ~12 |
| `schema-evolve.test.ts` (new) | Samples → mocked LLM → pending update; null proposal → no update | ~5 |
| `merge-themes.test.ts` (new, in core) | Link rewrite, content merge, fact merge, deletion, idempotency | ~10 |
| `lint-structural.test.ts` (extend) | Low-value, duplicate-theme, low-provenance | ~8 |
| `lint-cli.test.ts` (extend) | New `--fix` modes create correct pending updates | ~6 |
| `dream-integration.test.ts` (extend) | Canonicalization end-to-end, orphan-candidate persistence, size-trigger queues compaction | ~5 |
| `compact-integration.test.ts` (new) | Scheduled 7-day skip, size-triggered specific themes | ~4 |
| `chat-with-pulse.test.ts` (extend) | Judge verdicts, `file: yes` session state | ~6 |

**Expected total:** ~360 existing + ~89 new ≈ **~450 tests.**

UI sanity-check is manual: Schedule page cards for all four pipelines, Review page badges for each sub-kind, `_lint.md` sections in correct order, `theme-merge` approval actually rewrites links and deletes source file.

## Appendix — Decision log

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | All tiers in one plan |
| 2 | Theme canonicalization | Hybrid (deterministic + batched LLM); auto-merge on exact-post-normalization; propose on fuzzy |
| 3 | Compaction trigger | Both (size-inline + scheduled monthly with 7-day dedup) |
| 4 | Compaction output | Always pending; optional pre-compaction cold snapshot |
| 5 | Query-back policy | LLM-judged (yes/no/maybe), refined content, cheap-to-skip gate |
| 6 | Two-pass synthesis scope | Concept/entity only; project/source-summary stay single-pass |
| 7 | Two-pass sequencing | Last task in Dream section |
| 8 | New-theme confidence threshold | 0.5 |
| 9 | Schema evolution | Monthly; pending update; user approves |
| 10 | Fact store | Per-theme JSONL sidecars; append-only |

## Risks flagged during design

1. **Compaction can destroy information.** Mitigated by always-pending approval + optional cold snapshots.
2. **Two-pass synthesis may not justify its cost** for concept/entity pages in practice. Sequenced last so it can be cut under scope pressure.
3. **Schema evolution may rarely propose changes.** Acceptable for v1; if it consistently returns null for months, a future optimisation can back off to quarterly.
4. **Query-back may rarely fire** (per user prior). Cheap-to-skip gate ensures we don't pay for what we don't use.
5. **Backward-compat new fields might accumulate.** Each pipeline adds one optional sub-kind field to `PendingUpdate`. If this grows beyond four, a proper discriminated union with a `kind` field would be cleaner — but YAGNI until then.
