# Wiki-Style Dream Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the dream pipeline as an incremental wiki editor — multi-tag classification, cross-referenced themes, auto-generated index.md, append-only log.md, and batch review.

**Architecture:** The classifier returns 1-3 theme tags per entry (deterministic first, LLM fallback). The synthesiser receives all theme names for cross-referencing with `[[wiki-links]]`. After synthesis, index.md is generated deterministically and log.md is appended. All pending updates from one run share a `batchId` for grouped review.

**Tech Stack:** TypeScript, existing LLM provider abstraction, file-based vault

**Spec:** `docs/superpowers/specs/2026-04-12-wiki-style-dream-pipeline.md`

---

## File Map

### Modified files

| File | Change |
|---|---|
| `packages/core/src/types.ts` | `ClassificationResult.theme` → `.themes: string[]`. Add `batchId` to `PendingUpdate`. |
| `packages/dream/src/classify.ts` | Return `themes[]` instead of `theme`. Multi-tag from deterministic + LLM. |
| `packages/dream/src/synthesize.ts` | Accept `allThemeNames` param. Add `[[wiki-link]]` prompt. Add `batchId`. Group by themes array. |
| `packages/dream/src/index.ts` | After synthesis: call `generateIndex()`, call `appendLog()`. |
| `packages/ui/src/pages/review.ts` | Group by `batchId`. Add Approve All / Reject All. |
| `packages/ui/src/lib/tauri-bridge.ts` | Add `batchId` to `PendingUpdate` type. |
| `packages/mcp-server/src/tools/chat-with-pulse.ts` | Read index.md first, load only relevant themes. |

### New files

None — `index.md` and `log.md` are generated in `vault/warm/`.

---

## Task 1: Update types for multi-tag and batchId

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Update ClassificationResult**

In `packages/core/src/types.ts`, change:

```typescript
export interface ClassificationResult {
  entry: ActivityEntry;
  theme: string; // matched or new theme name
  confidence: number; // 0-1
}
```

to:

```typescript
export interface ClassificationResult {
  entry: ActivityEntry;
  themes: string[]; // 1-3 theme tags
  confidence: number; // 0-1
}
```

- [ ] **Step 2: Add batchId to PendingUpdate**

Change:

```typescript
export interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: ActivityEntry[];
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "edited";
}
```

to:

```typescript
export interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: ActivityEntry[];
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "edited";
  batchId?: string; // groups updates from the same dream run
}
```

- [ ] **Step 3: Update PendingUpdate type in tauri-bridge.ts**

In `packages/ui/src/lib/tauri-bridge.ts`, find the `PendingUpdate` interface and add `batchId?: string`.

- [ ] **Step 4: Build and test**

```bash
pnpm build && pnpm vitest run
```

Expected: Build succeeds. Some tests may fail if they reference `ClassificationResult.theme` — fix in the next task.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/ui/src/lib/tauri-bridge.ts
git commit -m "feat(core): update types for multi-tag classification and batch review"
```

---

## Task 2: Rewrite classifier for multi-tag

**Files:**
- Modify: `packages/dream/src/classify.ts`
- Modify: `packages/dream/test/classify.test.ts` (if exists)

- [ ] **Step 1: Update classifier to return themes array**

Rewrite `packages/dream/src/classify.ts`. The structure stays the same (pre-filter → deterministic → LLM fallback) but all outputs use `themes: string[]`:

Key changes:
- `deterministicClassify` returns `string[]` instead of `string | null` — can return multiple tags if entry mentions multiple projects
- LLM fallback prompt changes from "classify into one theme" to "list 1-3 relevant themes, return JSON: `[{"index": 0, "themes": ["name1", "name2"]}]`"
- Cap at 3 themes per entry
- Results use `themes: [...]` not `theme: "..."`

The pre-filter stays exactly as-is. The deterministic classifier needs one change: after finding the primary project from file paths, also check if the entry text mentions other known project names (from `existingThemes` param) and add those as secondary tags.

```typescript
function deterministicClassify(entry: ActivityEntry, existingThemes: string[]): string[] {
  const tags: string[] = [];
  
  // Primary: file path extraction (existing logic)
  const pathMatch = entry.log.match(/\/(?:Documents\/GitHub|Projects|repos|src)\/([a-zA-Z0-9_-]+)\//);
  if (pathMatch) tags.push(pathMatch[1].toLowerCase());

  // Primary: repo reference (existing logic)
  if (tags.length === 0) {
    const repoMatch = entry.log.match(/* existing regex */);
    if (repoMatch) tags.push(repoMatch[1].toLowerCase());
  }

  // Primary: heading extraction (existing logic)
  if (tags.length === 0) {
    const projectMention = entry.log.match(/^###?\s+([A-Za-z0-9_-]+)\s*$/m);
    if (projectMention) {
      const name = projectMention[1].toLowerCase();
      if (!["instructions", "output", "summary", "status", "highlights", "findings", "context"].includes(name)) {
        tags.push(name);
      }
    }
  }

  // Secondary: check if entry mentions other existing themes
  for (const theme of existingThemes) {
    if (tags.includes(theme)) continue;
    if (tags.length >= 3) break;
    // Only add if the theme name appears as a word boundary match
    const re = new RegExp(`\\b${theme.replace(/-/g, "[- ]?")}\\b`, "i");
    if (re.test(entry.log)) tags.push(theme);
  }

  return tags;
}
```

The `classifyEntries` function signature stays the same but returns `themes[]`:

```typescript
export async function classifyEntries(
  entries: ActivityEntry[],
  existingThemes: string[],
  provider: LlmProvider,
  model: string
): Promise<ClassificationResult[]> {
```

- [ ] **Step 2: Update any tests referencing `.theme`**

Find test files that use `ClassificationResult.theme` and update to `.themes`. Run:

```bash
grep -rn "\.theme\b" packages/dream/test/ packages/core/test/
```

Update each reference.

- [ ] **Step 3: Build and test**

```bash
pnpm build && pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/dream/src/classify.ts
git commit -m "feat(dream): multi-tag classification returning themes[] with deterministic + LLM"
```

---

## Task 3: Rewrite synthesiser for cross-references and batchId

**Files:**
- Modify: `packages/dream/src/synthesize.ts`

- [ ] **Step 1: Update function signature and grouping**

Change `synthesizeToPending` to:

```typescript
export async function synthesizeToPending(
  vault: Vault,
  classified: ClassificationResult[],
  provider: LlmProvider,
  model: string
): Promise<PendingUpdate[]> {
```

The grouping changes — since entries now have `themes[]` (plural), an entry can appear in multiple groups:

```typescript
const batchId = new Date().toISOString();
const byTheme = new Map<string, ClassificationResult[]>();

for (const item of classified) {
  for (const theme of item.themes) {
    const group = byTheme.get(theme) ?? [];
    group.push(item);
    byTheme.set(theme, group);
  }
}

// Get all theme names for cross-referencing
const allThemeNames = [...new Set([
  ...byTheme.keys(),
  ...(await listThemes(vault)),
])];
```

- [ ] **Step 2: Update synthesis prompt for cross-references**

For each theme's LLM call, add the list of other theme names to the prompt:

```typescript
const otherThemes = allThemeNames.filter((t) => t !== theme);
const crossRefSection = otherThemes.length > 0
  ? `\nOther themes in the wiki: ${otherThemes.join(", ")}. Add [[theme-name]] links where content relates to another theme.`
  : "";
```

Add `crossRefSection` to the end of the prompt, before the "Return ONLY" instruction.

- [ ] **Step 3: Add batchId to pending updates**

When creating the `PendingUpdate` object, add `batchId`:

```typescript
const update: PendingUpdate = {
  id: randomUUID(),
  theme,
  proposedContent,
  previousContent: existing?.content ?? null,
  entries: items.map((i) => i.entry),
  createdAt: new Date().toISOString(),
  status: "pending",
  batchId,
};
```

- [ ] **Step 4: Build and test**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/dream/src/synthesize.ts
git commit -m "feat(dream): cross-references and batchId in synthesis"
```

---

## Task 4: Add index.md and log.md generation

**Files:**
- Modify: `packages/dream/src/index.ts`

- [ ] **Step 1: Create generateIndex function**

Add to `packages/dream/src/index.ts` (or a new `packages/dream/src/wiki.ts`):

```typescript
import { readdir, readFile, writeFile, appendFile, mkdir } from "node:fs/promises";

async function generateIndex(vault: Vault): Promise<void> {
  const warmDir = vault.warmDir;
  const files = await readdir(warmDir);
  const themes: Array<{ name: string; summary: string; lastUpdated: string }> = [];

  for (const file of files) {
    if (!file.endsWith(".md") || file === "index.md" || file === "log.md") continue;
    if (file.startsWith("_")) continue; // skip _pending

    const raw = await readFile(join(warmDir, file), "utf-8");
    const name = file.replace(/\.md$/, "");

    // Extract lastUpdated from frontmatter
    const luMatch = raw.match(/lastUpdated:\s*(.+)/);
    const lastUpdated = luMatch?.[1]?.trim() ?? "";

    // Extract first line of Current Status as summary
    const statusMatch = raw.match(/## Current Status\n+(.+)/);
    const summary = statusMatch?.[1]?.slice(0, 100) ?? "";

    themes.push({ name, summary, lastUpdated });
  }

  themes.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));

  // Build index markdown
  const lines = ["# OpenPulse Knowledge Base", ""];

  // Simple grouping: all are listed together for now
  // (project vs topic heuristic can be added later)
  for (const t of themes) {
    const date = t.lastUpdated ? new Date(t.lastUpdated).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    lines.push(`- [[${t.name}]] — ${t.summary} (${date})`);
  }

  lines.push("");
  lines.push(`Last updated: ${new Date().toISOString()} | ${themes.length} themes`);

  await writeFile(join(warmDir, "index.md"), lines.join("\n"), "utf-8");
}
```

- [ ] **Step 2: Create appendLog function**

```typescript
async function appendLog(vault: Vault, type: string, detail: string): Promise<void> {
  const logPath = join(vault.warmDir, "log.md");
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
  const line = `## [${dateStr}] ${type} | ${detail}\n`;
  await appendFile(logPath, line, "utf-8");
}
```

- [ ] **Step 3: Call both after synthesis in main()**

In the `main()` function of `packages/dream/src/index.ts`, after `synthesizeToPending` and before `archiveProcessedHotFiles`:

```typescript
// Generate index and append log
const themeNames = pending.map((p) => p.theme).join(", ");
await generateIndex(vault);
await appendLog(vault, "dream", `${entries.length} entries → ${pending.length} updates (${themeNames})`);
```

- [ ] **Step 4: Build and test**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 5: Verify index.md and log.md**

Run the dream pipeline manually and check:

```bash
cat ~/OpenPulseAI/vault/warm/index.md
cat ~/OpenPulseAI/vault/warm/log.md
```

- [ ] **Step 6: Commit**

```bash
git add packages/dream/src/index.ts
git commit -m "feat(dream): generate index.md and append-only log.md after each run"
```

---

## Task 5: Batch review UI

**Files:**
- Modify: `packages/ui/src/pages/review.ts`
- Modify: `packages/ui/server.ts` (if pending endpoint needs changes)

- [ ] **Step 1: Group pending updates by batchId in review page**

Rewrite the `loadPending` function in `packages/ui/src/pages/review.ts`:

- Fetch pending updates as before
- Group them by `batchId` (updates without a batchId are their own group)
- For each batch, render a batch header with timestamp + count
- Under each batch header, render the individual theme cards (existing card logic)
- Add "Approve All" and "Reject All" buttons per batch

The batch header:

```typescript
const batchHeader = document.createElement("div");
batchHeader.className = "batch-header";

const batchTitle = document.createElement("span");
batchTitle.textContent = `Dream run: ${formatDate(batchId)} — ${updates.length} theme${updates.length > 1 ? "s" : ""} updated`;

const approveAllBtn = document.createElement("button");
approveAllBtn.className = "btn btn-success btn-sm";
approveAllBtn.textContent = "Approve All";
approveAllBtn.addEventListener("click", async () => {
  for (const u of batchUpdates) {
    await approveUpdate(u.id);
  }
  log("info", `Approved batch: ${batchId}`);
  await loadPending(listEl);
  updateReviewBadge();
});

const rejectAllBtn = document.createElement("button");
rejectAllBtn.className = "btn btn-danger btn-sm";
rejectAllBtn.textContent = "Reject All";
// similar handler
```

- [ ] **Step 2: Add batch-header CSS**

In `packages/ui/src/styles.css`:

```css
.batch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0;
  margin-top: 1rem;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.batch-header:first-child {
  margin-top: 0;
}

.batch-actions {
  display: flex;
  gap: 0.35rem;
}
```

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @openpulse/ui build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/review.ts packages/ui/src/styles.css
git commit -m "feat(ui): batch review with Approve All / Reject All"
```

---

## Task 6: Update chat_with_pulse to use index.md

**Files:**
- Modify: `packages/mcp-server/src/tools/chat-with-pulse.ts`

- [ ] **Step 1: Read index.md first, then load relevant themes**

In `handleChatWithPulse`, replace the current theme loading logic:

```typescript
// OLD: load all themes or search
const relevantThemes = await searchWarmFiles(vault, input.message);
const allThemes = relevantThemes.length > 0 ? relevantThemes : await readAllThemes(vault);
```

with:

```typescript
// NEW: read index.md for theme catalog, then load relevant ones
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let allThemes;
try {
  const indexContent = await readFile(join(vault.warmDir, "index.md"), "utf-8");
  // Extract theme names from index: [[theme-name]]
  const themeNames = [...indexContent.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
  
  // Find which themes are relevant to the query (simple keyword match)
  const queryWords = input.message.toLowerCase().split(/\s+/);
  const relevant = themeNames.filter(name => 
    queryWords.some(w => name.includes(w)) || 
    queryWords.some(w => indexContent.toLowerCase().includes(w))
  );
  
  if (relevant.length > 0) {
    allThemes = [];
    for (const name of relevant) {
      const theme = await readTheme(vault, name);
      if (theme) allThemes.push(theme);
    }
  }
} catch { /* index.md doesn't exist yet */ }

// Fallback to existing behavior if index doesn't help
if (!allThemes || allThemes.length === 0) {
  const relevantThemes = await searchWarmFiles(vault, input.message);
  allThemes = relevantThemes.length > 0 ? relevantThemes : await readAllThemes(vault);
}
```

- [ ] **Step 2: Build and test**

```bash
pnpm build && pnpm vitest run
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/tools/chat-with-pulse.ts
git commit -m "feat(mcp): chat_with_pulse uses index.md for targeted theme loading"
```

---

## Task 7: Tests

**Files:**
- Modify or create: `packages/dream/test/classify.test.ts`
- Modify or create: `packages/dream/test/synthesize.test.ts`

- [ ] **Step 1: Classification tests**

```typescript
import { describe, it, expect } from "vitest";

describe("multi-tag classification", () => {
  it("returns themes array instead of single theme", () => {
    // Test that result has themes[] not theme
  });

  it("caps at 3 themes per entry", () => {
    // Entry mentioning 5 projects → only 3 tags
  });

  it("deterministic classifier finds multiple projects from file paths", () => {
    // Entry with paths from two different projects → both tagged
  });

  it("pre-filter removes inactive entries before classification", () => {
    // "No activity detected" → filtered out entirely
  });

  it("LLM fallback returns array format", () => {
    // Mock LLM returning [{"index":0,"themes":["a","b"]}]
  });
});
```

- [ ] **Step 2: Synthesis tests**

```typescript
describe("wiki-style synthesis", () => {
  it("adds batchId to all pending updates", () => {
    // All updates from one run share same batchId
  });

  it("entry tagged to multiple themes appears in multiple updates", () => {
    // Entry with themes:["a","b"] → two pending updates
  });

  it("cross-reference prompt includes other theme names", () => {
    // Mock LLM, verify prompt contains "Other themes in the wiki: ..."
  });

  it("preserves existing activity log entries", () => {
    // Existing theme has history → history preserved in output
  });
});
```

- [ ] **Step 3: Index and log tests**

```typescript
describe("index.md generation", () => {
  it("generates markdown with all theme names", () => {
    // Create temp vault with themes → generateIndex() → verify content
  });

  it("excludes _pending and special files", () => {
    // index.md and log.md not listed as themes
  });
});

describe("log.md", () => {
  it("appends without overwriting", () => {
    // Write two entries → both present
  });

  it("format matches ## [date] type | detail", () => {
    // Verify line format
  });
});
```

- [ ] **Step 4: Build and run all tests**

```bash
pnpm build && pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/dream/test/
git commit -m "test(dream): add tests for multi-tag classification, batch synthesis, index and log"
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Build everything**

```bash
pnpm build
```

- [ ] **Step 2: Run all tests**

```bash
pnpm vitest run
```

- [ ] **Step 3: Start dev server and run collectors**

```bash
cd packages/ui && npx tsx server.ts &
sleep 3
curl -s -X POST http://localhost:3001/api/skills/github-activity/run
curl -s -X POST http://localhost:3001/api/skills/folder-watcher/run
```

- [ ] **Step 4: Trigger dream pipeline**

```bash
curl -s -X POST http://localhost:3001/api/orchestrator-run -H "Content-Type: application/json" -d '{"target":"dreamPipeline"}'
```

- [ ] **Step 5: Verify results**

Check:
1. Pending reviews have `batchId` and are grouped in Review page
2. `vault/warm/index.md` exists with theme catalog
3. `vault/warm/log.md` has a dream entry
4. Theme content contains `[[cross-references]]`
5. Approve All works
6. Dashboard shows themes correctly

- [ ] **Step 6: Test chat_with_pulse**

Via Claude Desktop or curl — ask "what have I been working on?" and verify it uses index.md to find relevant themes.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: address e2e verification issues"
```
