# OpenPulseAI — Project Context

## What this is

A local-first work journal and knowledge base. Automated collectors gather activity from GitHub, file systems, and other sources on schedules. An LLM synthesizes entries into curated wiki-style theme pages with cross-references. Users review and approve updates before they become permanent. Stakeholders can query the knowledge base via MCP without interrupting you.

## Architecture

pnpm workspace monorepo with 4 packages:

| Package | Purpose |
|---------|---------|
| `packages/core` | Vault I/O, config, LLM provider abstraction (Anthropic/OpenAI/Gemini/Ollama), skills system (loader/runner/scheduler/eligibility/security), orchestrator, logger, shared types |
| `packages/mcp-server` | MCP server (stdio + HTTPS) with 5 tools: `record_activity`, `ingest_document`, `query_memory`, `chat_with_pulse`, `submit_update` |
| `packages/dream` | Dream Pipeline: multi-tag classify → wiki-style synthesize with [[cross-references]] → generate index.md → append log.md → batch pending review |
| `packages/ui` | Control Center web app (Vite + vanilla TS + custom CSS). Dev API server at `server.ts`. Pages: Dashboard, Review, Skills, Schedule, Logs, Settings, Help |

## Key patterns

- **MCP SDK**: `@modelcontextprotocol/sdk` v1.29.0. Server uses `McpServer` with `server.tool()` (4-arg overload). HTTPS transport via `StreamableHTTPServerTransport` for Claude Desktop connector dialog.
- **LLM calls**: All go through `LlmProvider` interface in `packages/core/src/llm/provider.ts`. Factory at `createProvider(config)`. Adapters for Anthropic, OpenAI, Gemini, Ollama. Temperature parameter supported on all calls.
- **Skills**: SKILL.md files in `~/OpenPulseAI/skills/` (user) and `packages/core/builtin-skills/` (bundled). Frontmatter: name, description, schedule (cron), lookback, requires (bins, env), config (user-configurable fields with `{{placeholder}}` substitution). 4 bundled: github-activity, folder-watcher, google-daily-digest, weekly-rollup.
- **Orchestrator**: `packages/core/src/orchestrator.ts`. Uses `croner` for cron scheduling. Barrier pattern: auto-triggers dream pipeline when all enabled collectors have run since last dream. JSON state file at `vault/orchestrator-state.json`. Heartbeat every 60s. Missed-run detection on startup.
- **Dream Pipeline**: Multi-tag classification (deterministic first: file paths, repo names, headings → LLM fallback for ambiguous entries). Synthesis with `[[wiki-link]]` cross-references. Auto-generates `vault/warm/index.md` and appends to `vault/warm/log.md`. Batch review with shared `batchId`.
- **Security**: Skill scanner (`scanSkillForThreats`) blocks non-builtin skills with high-severity findings (network exfiltration, destructive commands, credential access, privilege escalation). Shell-escaping on config values. Env var filtering strips secrets unless declared in `skill.requires.env`.
- **Vault**: All data in `~/OpenPulseAI/vault/`. Hot = raw journals, Warm = curated theme pages + index.md + log.md, Pending = `warm/_pending/*.json`, Cold = monthly archives. Logs in `vault/logs/*.jsonl`.
- **Config**: `~/OpenPulseAI/config.yaml` with llm provider/model/apiKey/baseUrl. Skills are filesystem-based with optional `vault/skill-config/<name>.json` for user settings.
- **UI**: No framework. Vanilla TS with custom CSS (Shoelace loaded for theme CSS only, not used as components). Hash-based routing. Use `confirmDialog()` from `src/lib/dialog.ts` instead of `window.confirm()`. Dev API server in `server.ts` bridges UI to vault filesystem and starts the orchestrator.
- **ESM**: All packages use `"type": "module"`. Imports use `.js` extensions.
- **Tauri**: v2 desktop wrapper exists in `src-tauri/` with Rust backend. Vault I/O, config, skills discovery, sidecar spawning. Not yet tested end-to-end.

## Build & test

```bash
pnpm install && pnpm build    # Build all packages
pnpm vitest run               # Run all tests (~315 tests)
pnpm build:sea:mcp            # SEA binary for MCP server
pnpm build:sea:skills         # SEA binary for skills CLI
pnpm build:desktop            # Full Tauri desktop build
```

## Dev server

```bash
cd packages/ui
npx tsx server.ts &            # API server on :3001 (starts orchestrator)
npx vite --port 1420 &        # UI on :1420
```

## Current state

- 4 packages, 315 tests passing
- MCP server works with Claude Desktop (one-click setup from Settings page)
- Wiki-style dream pipeline with multi-tag classification and cross-references
- Orchestrator with visual Schedule page and barrier-based auto-triggering
- BYOM model picker (Anthropic/OpenAI/Gemini/Ollama with live API validation)
- Security scanner for untrusted skills
- Light/dark/system theme toggle
- Tauri v2 desktop wrapper built (needs end-to-end testing)

## Design docs

- `docs/superpowers/specs/2026-04-12-wiki-style-dream-pipeline.md` — current dream pipeline design
- `docs/superpowers/specs/2026-04-05-scheduler-orchestrator.md` — orchestrator design
- `docs/superpowers/specs/2026-04-04-byom-model-picker.md` — BYOM design
- `TODO.md` — project backlog

## What's next

See `TODO.md` for full backlog. Key items: theme lint/health check, cross-theme classification improvements, system tray, AI-guided skill setup, Tauri parity.
