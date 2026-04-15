<p align="center">
  <svg width="56" height="56" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#3b82f6;"/><stop offset="100%" style="stop-color:#06b6d4;"/></linearGradient></defs>
    <rect x="10" y="10" width="80" height="80" rx="15" fill="#151820"/>
    <path d="M25 50 H35 L42 35 L58 65 L65 50 H75" fill="none" stroke="#2a3040" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M25 50 H35 L42 35 L58 65 L65 50 H75" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</p>

<h1 align="center">OpenPulseAI</h1>

<p align="center">
  <strong>Your AI-powered work journal and knowledge base. Local-first. MCP-native.</strong>
</p>

<p align="center">
  <a href="#what-is-this">What is this?</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#skills">Skills</a> &bull;
  <a href="#inspiration">Inspiration</a> &bull;
  <a href="#license">License</a>
</p>

---

## What is this?

OpenPulse automatically tracks your work across projects and builds a persistent, curated knowledge base — a wiki that maintains itself.

It works like this:

1. **Collectors gather data on a schedule.** GitHub commits, file changes, and other sources feed into daily journal entries. You configure what to watch and when.

2. **The Dream Pipeline synthesizes** journals into wiki-style theme pages using your choice of LLM. Each entry can update multiple themes with `[[cross-references]]` between them.

3. **You approve everything.** Batch review with Approve All / Reject All. Nothing enters the knowledge base without your sign-off.

4. **Query your knowledge base** — via Claude Desktop, Claude Code, or any MCP client — and get accurate, grounded answers about what you've been working on.

```
Collectors ──→ Journals (hot) ──→ Dream Pipeline ──→ Theme Pages (warm)
  GitHub         daily logs        classify (deterministic)    wiki-style
  Files          raw activity      synthesize (LLM)           cross-referenced
  (scheduled)                      index.md + log.md          queryable via MCP
                                   batch review
```

The key insight (from [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)): the tedious part of maintaining a knowledge base isn't the reading or thinking — it's the bookkeeping. LLMs handle the cross-referencing, summarizing, and maintenance. You curate sources and ask questions.

## Architecture

```
packages/
├── core/           # Vault I/O, LLM providers, skills system, orchestrator, security
├── mcp-server/     # MCP tools: record_activity, query_memory, chat_with_pulse
├── dream/          # Dream Pipeline: classify → synthesize → index → review
├── ui/             # Control Center (Vite + vanilla TS) with dev API server
└── src-tauri/      # Tauri v2 desktop wrapper (Rust backend)
```

### The Vault

All data lives in human-readable Markdown files at `~/OpenPulseAI/vault/`. No database.

| Layer | Path | Purpose |
|-------|------|---------|
| **Journals** | `vault/hot/` | Daily activity logs from collectors |
| **Themes** | `vault/warm/` | Curated wiki pages — the knowledge base |
| **Index** | `vault/warm/index.md` | Auto-generated catalog of all themes |
| **Log** | `vault/warm/log.md` | Append-only record of pipeline activity |
| **Pending** | `vault/warm/_pending/` | AI-proposed updates awaiting review |
| **Archive** | `vault/cold/` | Monthly archives of processed journals |

### BYO LLM

Configure in Settings or `config.yaml`. Live API validation — enter your key, validate, pick a model:

| Provider | Models |
|----------|--------|
| Anthropic (Claude) | API key validated, model list fetched live |
| OpenAI (GPT) | API key validated, chat models filtered |
| Google (Gemini) | API key validated, generateContent models |
| Ollama (local) | No key needed, configurable base URL |

### Dream Pipeline

The pipeline follows a wiki-style incremental update pattern:

1. **Pre-filter**: Strip "no activity" noise before the LLM sees it
2. **Classify** (deterministic first): Extract projects from file paths, repo names, headings. LLM fallback only for ambiguous entries. Multi-tag: each entry can update 1-3 themes.
3. **Synthesize**: One LLM call per affected theme. Receives existing content + new entries + all theme names for `[[cross-references]]`. Temperature 0.1 for factual output.
4. **Generate**: `index.md` (deterministic catalog) and `log.md` (append-only record)
5. **Review**: Batch pending updates with shared `batchId`. Approve All / Reject All.

### Orchestrator

Visual Schedule page with time pickers and day selectors. Barrier pattern: dream pipeline auto-triggers when all enabled collectors have run since the last dream. Missed-run detection on startup.

## Getting Started

### Prerequisites

- Node.js 20+ (22+ for SEA builds)
- pnpm

### Install

```bash
git clone https://github.com/maxdraki/OpenPulseAI.git
cd OpenPulseAI
pnpm install
pnpm build
```

### Run the Control Center

```bash
cd packages/ui
pnpm dev    # Starts API server on :3001 + Vite on :1420
```

Open `http://localhost:1420`. Go to **Settings** to configure your LLM provider, then **Skills** to see available collectors.

### Connect Claude Desktop

Go to **Settings → Connections** and click **Connect** next to Claude Desktop. Or manually add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openpulse": {
      "command": "node",
      "args": ["/path/to/OpenPulseAI/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## Skills

Skills are [AgentSkills.io](https://agentskills.io)-compatible SKILL.md files. Natural language instructions that the LLM executes using CLI tools.

### Bundled skills

| Skill | Requires | Schedule | Description |
|-------|----------|----------|-------------|
| `github-activity` | [gh](https://cli.github.com) | Configurable | Watch specific repos (github.com + GHE) — commits and PRs |
| `gitlab-activity` | curl | Configurable | Merge requests, commits, issues, pipeline status |
| `folder-watcher` | find | Configurable | Track file changes across project directories |
| `confluence-activity` | curl | Configurable | Recently updated pages across selected spaces |
| `jira-activity` | curl | Configurable | Issues, sprint progress, comments |
| `linear-activity` | curl | Configurable | Issues, status changes, comments, cycle progress |
| `slack-activity` | curl | Configurable | Messages and mentions from key channels |
| `trello-activity` | curl | Configurable | Card moves, comments, due dates |
| `todoist-activity` | curl | Configurable | Completed tasks, new items, upcoming due dates |
| `sentry-activity` | curl | Configurable | Errors, unresolved issues, regressions |
| `google-daily-digest` | [gogcli](https://github.com/slashdevops/gog) | Configurable | Gmail + Calendar summary |
| `weekly-rollup` | — | Manual | Synthesize themes into a weekly status |

Skills have configurable settings (API tokens, watch paths, space/repo selectors) via the UI. Dependencies can be installed with one click.

### Write your own

Create `~/OpenPulseAI/skills/my-skill/SKILL.md`:

```yaml
---
name: my-skill
description: What this skill does
schedule: "0 22 * * *"
lookback: 24h
requires:
  bins: [some-cli]
config:
  - key: target_url
    label: URL to monitor
    default: https://example.com
    type: text
---

## Instructions

1. Run `some-cli fetch --url {{target_url}} --since yesterday --json`
2. Summarize the key findings
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `record_activity` | Log what an AI agent just did |
| `ingest_document` | Save a Markdown doc for processing |
| `submit_update` | Push a status update from an external source |
| `query_memory` | Search themes for status information |
| `chat_with_pulse` | Conversation with your knowledge base (uses index.md for targeted loading) |

## Inspiration

OpenPulse draws from [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the idea that LLMs should incrementally build and maintain a persistent wiki rather than rediscovering knowledge from scratch on every query. The wiki is a persistent, compounding artifact. The human curates sources and asks questions; the LLM does the bookkeeping.

## Project Status

- [x] Core vault (hot/warm/cold layers)
- [x] MCP server (stdio + HTTPS transports, 5 tools)
- [x] Wiki-style Dream Pipeline (multi-tag classify, cross-references, index.md, log.md)
- [x] BYO LLM (Anthropic, OpenAI, Gemini, Ollama)
- [x] Control Center UI (Dashboard, Review, Data Sources, Schedule, Logs, Settings, Help)
- [x] Skills system with security scanner, config system, one-click dependency install
- [x] Orchestrator with visual scheduler and barrier-based auto-triggering
- [x] 12 bundled skills (GitHub, GitLab, Confluence, Jira, Linear, Slack, Trello, Todoist, Sentry, Google, Folder Watcher, Weekly Rollup)
- [x] GitHub repo watcher — paste any github.com or GHE URL to watch specific repos
- [x] Confluence space picker — discover and select spaces via API
- [x] Tauri v2 desktop wrapper (Rust backend built, needs E2E testing)
- [x] One-click Claude Desktop connection
- [x] Light/dark/system theme toggle
- [ ] Theme lint/health check
- [ ] System tray (Tauri)
- [ ] AI-guided skill setup
- [ ] Notifications

See [TODO.md](TODO.md) for full backlog.

## License

[Apache License 2.0](LICENSE) — use it, modify it, distribute it. Attribution required. Patent grant included.

---

<p align="center">
  <sub>Built with curiosity and Claude.</sub>
</p>
