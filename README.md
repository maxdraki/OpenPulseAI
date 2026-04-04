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
  <strong>Your AI-powered Digital Twin. Local-first. MCP-native. Skill-driven.</strong>
</p>

<p align="center">
  <a href="#status">Status</a> &bull;
  <a href="#what-is-this">What is this?</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#skills">Skills</a> &bull;
  <a href="#license">License</a>
</p>

---

## Status

> **Work in Progress / Experimental**
>
> OpenPulse is under active development. APIs will change, features are incomplete, and things will break. Contributions and feedback welcome, but don't depend on this for anything critical yet.

## What is this?

OpenPulse eliminates the **Developer Status Tax** — the constant drain of context-switching to tell people what you're working on.

It works like this:

1. **AI agents report to OpenPulse** as you work. Claude Code, Cursor, or any MCP-compatible tool calls `record_activity` to log what was done.

2. **Skills pull from external sources** on a schedule. Gmail, Calendar, GitHub — any CLI tool or MCP server can feed data into OpenPulse via [AgentSkills.io](https://agentskills.io)-compatible SKILL.md files.

3. **The Dream Pipeline synthesizes** raw activity into curated, thematic summaries using your choice of LLM (Anthropic, OpenAI, or Gemini).

4. **You approve everything** before it becomes queryable. Nothing reaches your Digital Twin without your review.

5. **Stakeholders query your proxy** — via Claude Desktop, a Slack bot, or any MCP client — and get accurate, grounded answers without interrupting you.

```
AI Agents ──→ record_activity ──→ Hot Layer ──→ Dream Pipeline ──→ Warm Layer
Skills    ──→ (scheduled)    ──→ Hot Layer      ↓                    ↓
                                              _pending/        query_memory
                                                ↓              chat_with_pulse
                                           UI Approval              ↓
                                                            "What's the status
                                                             of the auth project?"
```

## Architecture

```
packages/
├── core/           # Vault I/O, config, BYO LLM provider abstraction
├── mcp-server/     # MCP tools: record_activity, query_memory, chat_with_pulse, submit_update
├── dream/          # Dream Pipeline: classify → synthesize → approve → archive
├── skills/         # Skill runner: discover SKILL.md files, execute on schedule
└── ui/             # Tauri-ready Control Center (Vite + Shoelace + DM Sans)
```

### The Vault

All data lives in human-readable Markdown files. No database.

| Layer | Path | Purpose |
|-------|------|---------|
| **Hot** | `vault/hot/` | Raw chronological logs — the write-ahead layer |
| **Warm** | `vault/warm/` | Curated theme files — the source of truth |
| **Pending** | `vault/warm/_pending/` | AI-proposed updates awaiting your approval |
| **Cold** | `vault/cold/` | Monthly archives of processed hot entries |

### BYO LLM

OpenPulse doesn't lock you into a provider. Configure in `config.yaml`:

| Provider | Config | Env var |
|----------|--------|---------|
| Anthropic (Claude) | `provider: anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI (GPT) | `provider: openai` | `OPENAI_API_KEY` |
| Google (Gemini) | `provider: gemini` | `GEMINI_API_KEY` |

## Getting Started

### Prerequisites

- Node.js 20+ (22+ recommended for [SEA builds](#single-executable))
- pnpm

### Install

```bash
git clone https://github.com/maxdraki/OpenPulseAI.git
cd OpenPulseAI
pnpm install
pnpm build
```

### Initialize the vault

```bash
mkdir -p ~/OpenPulseAI/vault/{hot/ingest,warm/_pending,cold,sessions}
mkdir -p ~/OpenPulseAI/skills

cat > ~/OpenPulseAI/config.yaml << 'EOF'
themes:
  - project-auth
  - hiring
  - infrastructure
llm:
  provider: anthropic
  model: claude-sonnet-4-5-20250929
EOF
```

### Configure Claude Desktop / Claude Code

Add to your MCP server config:

```json
{
  "mcpServers": {
    "openpulse": {
      "command": "node",
      "args": ["/path/to/OpenPulseAI/packages/mcp-server/dist/index.js"],
      "env": { "OPENPULSE_VAULT": "/home/you/OpenPulseAI" }
    }
  }
}
```

### Run the Control Center

```bash
cd packages/ui
pnpm dev    # Starts API server + Vite at http://localhost:1420
```

### Run the Dream Pipeline

```bash
ANTHROPIC_API_KEY=sk-... node packages/dream/dist/index.js
```

### Run skills

```bash
node packages/skills/dist/index.js --list     # See installed skills
node packages/skills/dist/index.js --run weekly-rollup   # Run a specific skill
```

## Skills

OpenPulse uses the [AgentSkills.io](https://agentskills.io) open standard. Skills are SKILL.md files — natural language instructions that the LLM executes using available CLI tools.

### Bundled skills

| Skill | Requires | Schedule | Description |
|-------|----------|----------|-------------|
| `google-daily-digest` | [gogcli](https://gogcli.sh) | Daily 10pm | Gmail + Calendar summary |
| `github-activity` | [gh](https://cli.github.com) | Weekdays 6pm | PRs, reviews, commits |
| `weekly-rollup` | — | Manual | Synthesize warm themes into a weekly status |

### Install from registry

```bash
cd ~/OpenPulseAI && npx skillsadd owner/repo
```

Or use the Skills page in the Control Center.

### Write your own

Create `~/OpenPulseAI/skills/my-skill/SKILL.md`:

```yaml
---
name: my-skill
description: What this skill does
schedule: "0 22 * * *"    # optional — omit for manual-only
lookback: 24h
requires:
  bins: [some-cli]
  env: [SOME_API_KEY]
---

## Instructions

1. Run `some-cli fetch --since yesterday --json` to get data
2. Summarize the key findings
3. Focus on what's actionable
```

OpenPulse discovers it automatically. The LLM executes the shell commands, synthesizes the output, and writes it to your hot layer for the Dream Pipeline to process.

### Single executable

Build self-contained binaries (requires Node.js from nodejs.org, not distro packages):

```bash
pnpm build
pnpm build:sea:mcp      # → dist/mcp-server
pnpm build:sea:dream     # → dist/dream
```

## MCP Tools

| Tool | Direction | Description |
|------|-----------|-------------|
| `record_activity` | Inbound | Log what an AI agent just did |
| `ingest_document` | Inbound | Save a Markdown doc for processing |
| `submit_update` | Inbound | Push a status update from an external source |
| `query_memory` | Outbound | Search warm layer for status information |
| `chat_with_pulse` | Outbound | Multi-turn conversation with your Digital Twin |

## Project status

- [x] Core vault (hot/warm/cold layers)
- [x] MCP server (5 tools)
- [x] Dream Pipeline (classify, synthesize, approve, archive)
- [x] BYO LLM (Anthropic, OpenAI, Gemini)
- [x] Control Center UI (Dashboard, Review, Skills, Settings)
- [x] Skills system (AgentSkills.io compatible)
- [x] SEA build scripts
- [ ] Tauri desktop wrapper (frontend works, Rust backend pending)
- [ ] Slack/Teams bot integration
- [ ] Embedding-based search for query_memory
- [ ] Skill-to-skill composition
- [ ] End-to-end encryption

## License

[Apache License 2.0](LICENSE) — use it, modify it, distribute it. Attribution required. Patent grant included.

---

<p align="center">
  <sub>Built with curiosity and Claude.</sub>
</p>
