# OpenPulse Skills System

## Problem

The current collector uses rigid TypeScript templates (gmail.ts, calendar.ts, github.ts) and an LLM auto-discover fallback to pull data from external sources. Templates are brittle (hardcoded tool names, assumed response shapes), and the auto-discover path is a separate code path from templates. Users can't easily add new data sources without writing TypeScript.

Meanwhile, the broader AI ecosystem has converged on the AgentSkills.io standard — a simple, open format where skills are Markdown files with natural language instructions. Claude Code, OpenClaw, Gemini CLI, Cursor, Copilot, and 25+ other agents all support this format. A registry at skills.sh hosts 13,000+ community skills installable via `npx skillsadd`.

## Solution

Replace the collector's template/auto-discover system with an AgentSkills.io-compatible skill runner. Skills are SKILL.md files — natural language instructions that the LLM executes using available tools (shell commands, MCP clients, APIs). OpenPulse extends the standard with `schedule` and `lookback` frontmatter fields for automated execution.

The `@openpulse/collector` package is refactored into `@openpulse/skills`. The MCP client wrapper and scheduler logic are kept. Templates and auto-discover are deleted and replaced by bundled SKILL.md files.

## SKILL.md Format

Follows the AgentSkills.io specification with OpenPulse extensions.

### Standard Fields (AgentSkills.io)

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier, lowercase with hyphens, max 64 chars |
| `description` | Yes | What the skill does — used by OpenPulse to display in UI and for `chat_with_pulse` to invoke on demand |
| `requires.bins` | No | CLI binaries that must be on PATH (all must exist) |
| `requires.env` | No | Environment variables that must be set |

### OpenPulse Extensions

| Field | Required | Description |
|-------|----------|-------------|
| `schedule` | No | Cron expression (5-field). If omitted, skill is query-only (invokable manually or by `chat_with_pulse`) |
| `lookback` | No | Duration string (`1h`, `6h`, `24h`, `1w`, `30d`). Passed to the skill as context. Defaults to `24h` |

### Example: Google Daily Digest

```yaml
---
name: google-daily-digest
description: Summarize today's Gmail and Calendar activity using gogcli
schedule: "0 22 * * *"
lookback: 24h
requires:
  bins: [gog]
  env: [GOG_ACCOUNT]
---

## Context

You are collecting the user's daily Google Workspace activity to produce
a concise summary for the OpenPulse vault.

## Instructions

1. Run `gog gmail search 'newer_than:1d' --max 50 --json` to get today's emails
2. Run `gog calendar events list --from today --to tomorrow --json` to get today's events
3. For each email thread, extract: subject, participants, key decisions or action items
4. For each calendar event, note: title, attendees, whether attended or declined
5. Group findings by theme (project names, people, topics)

## Output Format

Write the summary as a single Markdown document. Start with a date header.
Focus on what's actionable or status-relevant. Skip newsletters and automated notifications.
```

### Example: GitHub Activity

```yaml
---
name: github-activity
description: Summarize recent GitHub activity — PRs, reviews, commits, issues
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
---

## Instructions

1. Run `gh pr list --author @me --state all --json title,state,updatedAt,url --limit 20`
2. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 20`
3. Run `gh api notifications --method GET -F all=true -F since={{since}}` for recent notifications
4. Summarize: PRs opened/merged/reviewed, issues commented on, repos active in
```

### Example: Weekly Rollup (no schedule — manual only)

```yaml
---
name: weekly-rollup
description: Synthesize all warm themes into a stakeholder-friendly weekly summary
requires: {}
---

## Instructions

1. Read all files in the vault warm directory
2. For each theme, summarize the key changes from the past week
3. Organize by priority — what's most important for stakeholders
4. Write a concise weekly status update in Markdown

## Output Format

# Weekly Status — {{date}}

## Highlights
- ...

## By Theme
### [theme-name]
- ...
```

## Skill Discovery

### Scan Locations (priority order — higher overrides lower by name)

1. `~/OpenPulseAI/skills/` — user-installed skills (highest priority)
2. `packages/skills/builtin/` — bundled skills shipped with OpenPulse

### Discovery Algorithm

Same pattern as Gemini CLI's `skillLoader.ts`:

1. For each scan location, glob for `*/SKILL.md`
2. Parse YAML frontmatter (name, description required; schedule, lookback, requires optional)
3. Build a Map keyed by name — later sources override earlier ones
4. Return list of `SkillDefinition` objects

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  location: string;        // absolute path to SKILL.md
  body: string;            // markdown content after frontmatter
  schedule?: string;       // cron expression
  lookback: string;        // default "24h"
  requires: {
    bins: string[];
    env: string[];
  };
}
```

## Eligibility Evaluation

Before a skill can run, verify its requirements:

1. **Binary check**: For each entry in `requires.bins`, verify the binary exists on PATH using `which`
2. **Env check**: For each entry in `requires.env`, verify the environment variable is set

Skills that fail eligibility are marked as `ineligible` with a reason. The UI shows this prominently so users know what to install.

## Skill Execution (The Runner)

### Dynamic Context Injection

The SKILL.md body contains shell commands in backtick code blocks (e.g., `` `gog gmail search ...` ``). The runner uses a pre-execution step inspired by Claude Code's `` !`command` `` syntax:

1. **Parse** the SKILL.md body for shell commands referenced in numbered instruction steps
2. **Execute** each command via `child_process.execFile`, capturing stdout
3. **Build prompt** with the raw command outputs injected as context
4. **Send to LLM** via `provider.complete()` with a system prompt instructing it to synthesize the data
5. **Capture output** — the LLM's response is the skill's result

### System Prompt

```
You are OpenPulse executing the skill "{{name}}".

Your task: follow the instructions below and produce a Markdown summary of what you find.
The shell commands have already been executed and their outputs are provided below.
Synthesize these raw outputs into a clear, concise summary.

Today's date: {{date}}
Lookback period: {{lookback}} (since {{since}})
```

### Execution Flow

```
1. Load SKILL.md body
2. Extract shell commands from instruction steps
3. Execute each command, capture stdout/stderr
4. Build prompt: system prompt + SKILL.md instructions + command outputs
5. Call provider.complete()
6. Write LLM response to hot layer as ActivityEntry (source: skill name, theme: "auto")
7. Update skill execution state (timestamp, status, entries collected)
```

### Error Handling

- If a required binary is missing: skip skill, mark ineligible
- If a shell command fails: include the error in the prompt context, let the LLM handle it gracefully
- If the LLM call fails: save error state, log to stderr
- If the skill produces empty output: save state with 0 entries, don't write to hot

## Scheduler

Reuses existing `scheduler.ts` logic but reads schedule from SKILL.md frontmatter instead of `config.yaml`.

- `isDue(schedule, lastRunAt, now)` — unchanged
- State stored in `vault/collector-state/{skill-name}.json` — unchanged
- Skills without a `schedule` field are never auto-executed (manual/query only)

## CLI Interface

The `@openpulse/skills` binary replaces `@openpulse/collector`:

```bash
openpulse-skills                     # Run all scheduled skills that are due
openpulse-skills --run <name>        # Run a specific skill regardless of schedule
openpulse-skills --list              # List all skills with status and eligibility
openpulse-skills --check             # Check eligibility of all skills
```

## Registry Support (skills.sh)

Any skill published to skills.sh that follows the AgentSkills.io format works with OpenPulse. Installation:

```bash
cd ~/OpenPulseAI && npx skillsadd owner/repo
```

This clones the skill directory into `~/OpenPulseAI/skills/`. OpenPulse discovers it on next scan.

The UI Skills page includes an "Install from Registry" input where users paste `owner/repo`.

Removal: delete the skill directory from `~/OpenPulseAI/skills/`.

## UI: Skills Page

Replaces the "Sources" page in the Control Center.

### Skills List View

For each installed skill:
- **Name** and **description**
- **Schedule** (human-readable, e.g., "Every day at 10pm") or "Manual only"
- **Status dot**: green (last run success), red (last run error), gray (never run)
- **Eligibility**: green check if all requirements met, or red X with list of missing bins/env
- **Last run**: timestamp + entries collected
- **Actions**: "Run Now" button, "Remove" button

### Install Section

- Text input for `owner/repo` + "Install" button
- Runs `npx skillsadd <repo>` in the vault directory
- Refreshes skill list after install

### Skill Detail (expandable)

- Full SKILL.md body rendered as formatted text
- Shell commands highlighted
- Execution log from last run

## Package Structure Changes

### Delete

```
packages/collector/src/templates/          # All template files
packages/collector/src/auto-discover.ts    # LLM auto-discovery
packages/collector/test/templates/         # Template tests
packages/collector/test/auto-discover.test.ts
```

### Rename

```
packages/collector/ → packages/skills/
@openpulse/collector → @openpulse/skills
openpulse-collect → openpulse-skills
```

### Keep (with modifications)

```
packages/skills/src/mcp-client.ts          # Kept as-is — available for MCP-based skills
packages/skills/src/scheduler.ts           # Modified to read from SkillDefinition instead of SourceConfig
```

### Create

```
packages/skills/src/loader.ts              # Discover + parse SKILL.md files (port of Gemini CLI pattern)
packages/skills/src/runner.ts              # Execute a skill: extract commands, run them, send to LLM
packages/skills/src/eligibility.ts         # Check requires.bins and requires.env
packages/skills/src/index.ts               # Updated CLI entry point
packages/skills/builtin/
├── google-daily-digest/SKILL.md
├── github-activity/SKILL.md
└── weekly-rollup/SKILL.md
packages/skills/test/loader.test.ts
packages/skills/test/runner.test.ts
packages/skills/test/eligibility.test.ts
```

### Modify

```
packages/core/src/types.ts                 # Replace SourceConfig with SkillDefinition type
packages/core/src/config.ts                # Remove sources[] parsing (skills are filesystem-based)
packages/ui/src/pages/sources.ts           # Rename to skills.ts, update UI
packages/ui/server.ts                      # Replace source endpoints with skill endpoints
packages/ui/index.html                     # Rename nav item Sources → Skills
packages/ui/src/main.ts                    # Update route
packages/ui/src/lib/tauri-bridge.ts        # Replace source API functions with skill functions
packages/ui/src/styles.css                 # Rename .source-* classes to .skill-*
```

## Interaction with Existing System

### Hot Layer

Skills write to hot via `appendActivity()` with `source: skill-name` and `theme: "auto"`. No change to hot layer format.

### Dream Pipeline

Unchanged. Reads hot entries, classifies (entries tagged `theme: "auto"` go through LLM classification), synthesizes into pending, archives to cold.

### Approval Gate

Unchanged. All synthesized content goes through `_pending/` → UI approval → warm. Nothing reaches `query_memory` or `chat_with_pulse` without user approval.

### chat_with_pulse

Query-only skills (no schedule) can be mentioned in chat responses. When a user asks a question via `chat_with_pulse`, the tool could suggest relevant skills to run. This is a future enhancement — for now, skills must be invoked manually or on schedule.

## Migration Path

1. `config.yaml` `sources:` section becomes ignored (kept for backward compat, not read)
2. Any previously configured sources need to be recreated as SKILL.md files in `~/OpenPulseAI/skills/`
3. The bundled skills cover the three template cases (Gmail, Calendar, GitHub)

## Out of Scope

- Skill-to-skill composition (one skill invoking another)
- Skill versioning/updates from registry
- Sandboxed skill execution
- MCP-based skill execution (skills using MCP client directly — future enhancement)
- Skills with multi-turn LLM interaction (current runner is single-turn)
