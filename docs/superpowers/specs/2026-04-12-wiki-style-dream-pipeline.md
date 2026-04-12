# Wiki-Style Dream Pipeline — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Inspiration:** [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Goal

Redesign the dream pipeline to behave like a wiki editor rather than a summariser. Each dream run incrementally updates themes, adds cross-references between them, maintains an auto-generated index, and keeps an append-only log. Themes become a persistent, compounding knowledge base — not summaries that get rewritten each run.

## Decisions

- **Multi-tag classification** — each journal entry can be tagged to 1-3 themes (not just one)
- **Cross-references** — themes link to each other with `[[wiki-link]]` syntax
- **index.md** — auto-generated catalog of all themes, deterministic (no LLM)
- **log.md** — append-only chronological record of all pipeline activity
- **Batch review** — all updates from one dream run grouped together with Approve All / Reject All
- **chat_with_pulse uses index.md** — reads index first, loads only relevant themes

## Pipeline Flow

```
1. Load new journals (vault/hot/)
2. Pre-filter noise (strip "inactive/no changes" lines)
3. Multi-tag classification:
   a. Deterministic first (file paths → project name, repo refs → project name)
   b. LLM fallback returns 1-3 theme tags per entry
   c. Cap at 3 tags per entry
4. Load context: all existing themes + index.md
5. Group entries by theme tag (an entry may appear in multiple groups)
6. For each affected theme — one LLM call:
   - Input: existing theme content + new entries + list of all theme names
   - Output: updated theme with [[cross-references]]
   - Temperature: 0.1
7. Generate index.md (deterministic — no LLM)
8. Append to log.md
9. Create ONE batch pending review (all updates share a batchId)
```

## Multi-tag Classification

The `ClassificationResult` type changes:

```typescript
interface ClassificationResult {
  entry: ActivityEntry;
  themes: string[];     // was: theme: string
  confidence: number;
}
```

Rules:
- Deterministic pass always produces the primary tag
- LLM fallback returns an array of 1-3 themes
- If the entry mentions files in multiple project directories, each gets a tag
- Cap at 3 tags per entry — more means the entry is too broad

## Synthesis with Cross-references

Each theme's LLM call receives:
- The current theme content (existing markdown)
- New entries tagged for this theme
- List of all other theme names: "Other themes in the wiki: aigis, security, github-activity"

The prompt instructs:
- Preserve existing activity log entries
- Add new entries as dated sections (most recent first)
- Add `[[theme-name]]` links where content relates to another theme
- Keep Current Status section updated
- Temperature: 0.1 for factual output

Example output:

```markdown
## Current Status
Skills system refactored into core. Security scanner added. See also: [[security]]

## Activity Log
### 2026-04-10 — Skills refactoring
Collapsed @openpulse/skills into core. Added threat scanner ([[security]]),
shell escaping, env filtering.
```

## index.md

Auto-generated deterministic file in `vault/warm/index.md`. Updated after every dream run. Not LLM-generated — built from code by reading all theme files.

Format:

```markdown
# OpenPulse Knowledge Base

## Projects
- [[openpulse]] — Skills refactoring, security hardening (updated 10 Apr)
- [[aigis]] — Encryption at rest, MCP validation (updated 4 Apr)

## Topics
- [[github-activity]] — Cross-project commit and PR tracking (updated 12 Apr)

Last updated: 2026-04-12T19:00:00Z | 4 themes | 12 entries processed
```

Grouping heuristic: if theme name matches a known project directory in the configured watch paths, it's a Project. Otherwise it's a Topic.

## log.md

Append-only file in `vault/warm/log.md`. Never archived, never rewritten. Written by dream pipeline and orchestrator.

Format:

```markdown
## [2026-04-12 19:00] dream | 2 entries → updated openpulse, github-activity
## [2026-04-12 19:00] collector | folder-watcher (1 entry)
## [2026-04-12 19:00] collector | github-activity (1 entry)
```

Parseable with `grep "^## \[" log.md | tail -5`.

## Batch Review

Pending updates gain a `batchId` field (ISO timestamp of the dream run). All updates from the same run share the batch ID.

Review page groups updates by batch:

```
Dream run: 12 Apr, 19:00 — 3 themes updated
├── openpulse ▸ (expand to preview)  [Approve] [Reject]
├── github-activity ▸               [Approve] [Reject]
├── security ▸                      [Approve] [Reject]
[Approve All] [Reject All]
```

Individual approve/reject per theme still works within a batch.

## chat_with_pulse Changes

Instead of loading all themes on every query, `chat_with_pulse`:
1. Reads `vault/warm/index.md`
2. Uses the index to identify which themes are relevant to the user's question
3. Loads only those themes into context

This scales better as themes grow and gives the LLM better signal-to-noise.

## Files Changed

### Modified

| File | Change |
|---|---|
| `packages/dream/src/classify.ts` | Return `themes: string[]` instead of single `theme`. Multi-tag from deterministic + LLM. |
| `packages/dream/src/synthesize.ts` | Pass all theme names for cross-refs. `[[wiki-link]]` in prompt. Add `batchId` to pending updates. |
| `packages/dream/src/index.ts` | After synthesis: generate `index.md`, append to `log.md`. |
| `packages/core/src/types.ts` | `ClassificationResult.themes: string[]`. Add `batchId?: string` to `PendingUpdate`. |
| `packages/ui/src/pages/review.ts` | Group by `batchId`. Approve All / Reject All buttons. |
| `packages/ui/server.ts` | Pending-updates endpoint returns `batchId`. |
| `packages/mcp-server/src/tools/chat-with-pulse.ts` | Read `index.md` first, load only relevant themes. |

### Not changed

- Collectors / skill runner
- Orchestrator
- Dashboard (already shows themes inline)
- Journals page

## Testing

### Unit tests — classification

- `preFilter` strips inactive lines, keeps active ones
- `deterministicClassify` returns multiple tags for multi-project entries
- Multi-tag capped at 3
- LLM fallback returns array format
- Entries with no deterministic match fall through to LLM

### Unit tests — synthesis

- `batchId` present on all pending updates from same run
- `[[theme-name]]` cross-references appear in output
- Existing activity log entries preserved (regression for history loss)
- Empty/no-change entries produce no pending update

### Unit tests — index.md

- Generates correct markdown from theme files
- Groups projects vs topics
- Updates timestamp

### Unit tests — log.md

- Appends entries, never overwrites
- Format matches `## [date] type | description`

### Integration — batch review

- Multiple updates with same `batchId` group together
- Approve All approves all in batch
- Reject All rejects all in batch
- Individual approve/reject works within batch

### End-to-end

- Run collectors → dream → verify: themes updated, index.md generated, log.md appended, pending reviews have batchId, batch review works

## Out of Scope (v1)

- Clickable `[[wiki-links]]` in the UI (just text for now)
- Lint / health check (separate backlog item)
- Embedding-based search (index.md is enough at this scale)
- Obsidian integration
