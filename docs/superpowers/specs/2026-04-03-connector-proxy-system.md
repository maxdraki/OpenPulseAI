# OpenPulseAI Connector & Proxy System

## Problem

OpenPulseAI currently only receives data when AI agents push to it via MCP tools. Users also have activity scattered across Gmail, Calendar, GitHub, Slack, and other services. Manually reporting this defeats the purpose. OpenPulse should actively pull from these sources, synthesize everything, and serve as a queryable proxy — a "Digital Twin" that stakeholders can ask for status updates without interrupting the user.

## Solution

A pure-MCP connector system. OpenPulse acts as an MCP **client** to pull data from registered Source MCP servers on configurable schedules, and as an MCP **server** to serve synthesized results — including multi-turn chat for Slack/Teams integration.

## Architecture

```
Source MCPs ──→ Collector ──→ Hot Layer ──→ Dream Pipeline ──→ _pending/ ──→ UI Approval ──→ Warm Layer
                                                                                                 │
                                                                              OpenPulse MCP ←────┘
                                                                                │
                                                                    ┌───────────┼───────────┐
                                                              query_memory  chat_with_pulse  submit_update
                                                                    │           │               │
                                                              Claude Desktop  Slack/Teams   Humans/Bots
```

### Components

**1. `@openpulse/collector`** — New package. MCP client that connects to Source MCPs on a per-source schedule, calls their tools to gather activity, and writes raw results to the hot layer.

**2. Source Registry** — Source MCP configurations stored in `config.yaml`, managed via the Control Center UI ("Sources" page).

**3. New outbound MCP tools** — Added to `@openpulse/mcp-server`:
- `chat_with_pulse` — multi-turn conversational queries
- `submit_update` — push Markdown updates into hot

## Collector (`@openpulse/collector`)

### Responsibilities

- Read source configurations from `config.yaml`
- Determine which sources are due to run based on their schedule
- For each due source:
  1. Spawn the MCP server process
  2. Connect as an MCP client via stdio transport
  3. Call `listTools()` to discover available tools
  4. Execute collection (template or LLM-driven)
  5. Write results as hot layer entries, tagged with source name
  6. Disconnect and kill the MCP server process
- Track last-run timestamps per source in `vault/collector-state.json`

### Collection Strategies

**Template-driven** (for known sources): A predefined list of tool calls with variable substitution. Ships with templates for Gmail, Google Calendar, and GitHub.

```typescript
interface CollectionTemplate {
  name: string;
  description: string;
  steps: Array<{
    tool: string;
    args: Record<string, string>; // supports {{since}}, {{until}}, {{lookback}}
  }>;
}
```

Example Gmail template:
```typescript
{
  name: "gmail",
  description: "Collect sent and received emails",
  steps: [
    { tool: "search_emails", args: { query: "after:{{since_date}} before:{{until_date}}", max_results: "50" } }
  ]
}
```

**LLM-driven** (for unknown sources): Send the tool list and a prompt to the configured LLM: "Given these MCP tools, gather all user activity from the last {lookback}. Call the most relevant tools." The LLM decides which tools to call and with what parameters.

**Hybrid selection**: If a source has `template: <name>`, use the template. If `template: null` or omitted, use LLM auto-discovery.

### CLI Interface

```bash
openpulse-collect                    # Run all sources due now
openpulse-collect --source gmail     # Run a specific source
openpulse-collect --all              # Run all sources regardless of schedule
openpulse-collect --dry-run          # Show what would run without executing
```

### Hot Layer Output Format

Each collected item is written as a standard hot entry:

```markdown
## 2026-04-03T23:00:00Z
**Theme:** auto
**Source:** gmail

Subject: Re: Auth migration plan
From: alice@example.com
Received: 2026-04-03T14:32:00Z

Discussion about migrating from session cookies to JWT tokens. Alice confirmed the deadline is next Friday.

---
```

The `**Theme:** auto` tag tells the Dream Pipeline to classify this entry using the LLM rather than assuming a theme.

## Source Registry (config.yaml)

```yaml
sources:
  - name: gmail
    command: npx
    args: ["-y", "@anthropic/gmail-mcp"]
    schedule: "0 23 * * *"        # cron expression: 11pm daily
    lookback: 24h                  # how far back to query
    template: gmail                # built-in template
    enabled: true

  - name: google-calendar
    command: npx
    args: ["-y", "@anthropic/google-calendar-mcp"]
    schedule: "0 23 * * *"
    lookback: 24h
    template: google-calendar
    enabled: true

  - name: github
    command: node
    args: ["/path/to/github-mcp/dist/index.js"]
    schedule: "0 17 * * 5"        # 5pm every Friday
    lookback: 1w
    template: null                 # LLM auto-discovery
    enabled: true
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"

  - name: custom-crm
    command: node
    args: ["/path/to/crm-mcp.js"]
    schedule: "0 9 * * 1-5"       # 9am weekdays
    lookback: 24h
    template: null                 # LLM figures it out
    enabled: false
```

### Schedule Fields

- `schedule`: Cron expression (5-field)
- `lookback`: Duration string — `1h`, `24h`, `1w`, `30d`
- `enabled`: Boolean, allows disabling without removing config

### Collector State

`vault/collector-state.json` tracks when each source was last collected:

```json
{
  "gmail": { "lastRun": "2026-04-03T23:00:00Z", "status": "ok", "entriesCollected": 12 },
  "github": { "lastRun": "2026-03-28T17:00:00Z", "status": "ok", "entriesCollected": 8 }
}
```

## New MCP Tools

### `chat_with_pulse`

Multi-turn conversational interface to the warm layer. This is the "Digital Twin" — what Slack/Teams bots call to ask questions on your behalf.

**Input:**
```typescript
{
  message: string;       // The user's question
  sessionId?: string;    // Optional session ID for continuity. New session created if omitted.
}
```

**Behavior:**
1. Load or create session from `vault/sessions/{sessionId}.json`
2. Read all warm theme files for context
3. Send conversation history + warm context + new message to LLM
4. Return the response and updated session ID

**Output:**
```typescript
{
  content: [{ type: "text", text: "The auth migration is on track..." }],
  sessionId: "abc-123"
}
```

**Session storage** (`vault/sessions/{id}.json`):
```json
{
  "id": "abc-123",
  "messages": [
    { "role": "user", "content": "What's the status of the auth project?" },
    { "role": "assistant", "content": "The auth migration is on track..." }
  ],
  "themesConsulted": ["project-auth"],
  "createdAt": "2026-04-03T10:00:00Z",
  "lastActivity": "2026-04-03T10:00:05Z"
}
```

Sessions expire after 24 hours of inactivity. The Collector or Dream pipeline cleans up expired sessions.

### `submit_update`

Allows humans or bots to push a status update directly into the hot layer without going through `record_activity`. Accepts structured Markdown.

**Input:**
```typescript
{
  content: string;       // Markdown content
  theme?: string;        // Optional theme tag
  author?: string;       // Who submitted this
}
```

**Behavior:** Writes to hot layer as a standard entry. Identical to `record_activity` but with an `author` field instead of `source`, signaling it came from a human or external bot rather than an AI agent.

## Control Center: Sources Page

New page in the UI at `#sources` (added to sidebar nav). Features:

**Source list view:**
- Shows all registered sources with name, schedule, last run time, status (ok/error/never run), entries collected
- Toggle enabled/disabled per source
- "Run Now" button per source
- "Add Source" button

**Add/Edit source modal:**
- Name (text input)
- Command + args (text inputs)
- Schedule (cron expression with human-readable preview, e.g., "Every day at 11pm")
- Lookback window (dropdown: 1h, 6h, 12h, 24h, 1w)
- Template (dropdown: auto-discover, gmail, google-calendar, github)
- Environment variables (key-value pairs)
- "Test Connection" button — spawns the MCP server, calls listTools(), shows available tools

**Pre-filled templates:**
When adding a source, offer quick-start buttons for known services (Gmail, Calendar, GitHub) that pre-fill the command/args/template fields. User just needs to provide credentials.

## Interaction With Existing System

### Dream Pipeline

No changes to Dream's core logic. The Collector writes standard hot entries. Dream already reads hot entries, classifies them, and synthesizes into pending updates. Entries from external sources use `**Theme:** auto` which signals the classifier to use LLM classification rather than a pre-assigned theme.

### Approval Gate

The existing approval flow is unchanged. All synthesized content goes through `_pending/` → UI approval → warm. This is critical for the "Digital Twin" trust model — nothing a stakeholder reads via `chat_with_pulse` was unseen by the user.

### Privacy

Raw external data (email bodies, calendar details) lives only in the hot layer. After Dream processes it, hot entries are archived to cold. Only the synthesized, user-approved summaries in warm are exposed via MCP tools. Raw data never leaves the local machine.

## Package Structure

New package: `packages/collector/`

```
packages/collector/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry point
│   ├── scheduler.ts          # Determine which sources are due
│   ├── client.ts             # MCP client — connect, call tools, disconnect
│   ├── collect.ts            # Orchestrate collection for a single source
│   ├── templates/
│   │   ├── index.ts          # Template registry
│   │   ├── gmail.ts          # Gmail collection template
│   │   ├── google-calendar.ts
│   │   └── github.ts
│   └── llm-discover.ts       # LLM-driven tool discovery fallback
└── test/
    ├── scheduler.test.ts
    ├── collect.test.ts
    └── templates.test.ts
```

Modified packages:
- `packages/core/src/types.ts` — add `SourceConfig`, `CollectorState` types
- `packages/core/src/config.ts` — parse `sources` section
- `packages/mcp-server/src/tools/chat-with-pulse.ts` — new tool
- `packages/mcp-server/src/tools/submit-update.ts` — new tool
- `packages/ui/src/pages/sources.ts` — new Sources page
- `packages/ui/server.ts` — new API endpoints for source management

## Dependencies

- `@modelcontextprotocol/sdk` — MCP client (already in the monorepo, used by mcp-server tests)
- No new external dependencies for collector core

## Out of Scope (v2+)

- Real-time streaming from sources (webhooks, SSE)
- Source-level access control (which stakeholders can see which sources)
- Federated OpenPulse (multiple users' OpenPulse instances sharing data)
- Slack/Teams bot wrapper (consumers of `chat_with_pulse` — separate project)
- End-to-end encryption of warm layer
