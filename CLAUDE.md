# OpenPulseAI — Project Context

## What this is

A local-first, MCP-native "Digital Twin" proxy. AI agents report activity, skills pull from external sources on schedules, an LLM synthesizes everything into curated thematic summaries, and stakeholders can query your proxy without interrupting you.

## Architecture

pnpm workspace monorepo with 5 packages:

| Package | Purpose |
|---------|---------|
| `packages/core` | Vault I/O (hot/warm/cold layers), config loader, BYO LLM provider abstraction (Anthropic/OpenAI/Gemini), shared types |
| `packages/mcp-server` | MCP server (stdio) with 5 tools: `record_activity`, `ingest_document`, `query_memory`, `chat_with_pulse`, `submit_update` |
| `packages/dream` | Dream Pipeline CLI: classify hot entries → synthesize into pending → user approves → warm layer |
| `packages/skills` | AgentSkills.io-compatible skill runner. Discovers SKILL.md files, checks eligibility, pre-executes shell commands, sends to LLM, writes output to hot |
| `packages/ui` | Control Center web app (Vite + vanilla TS + Shoelace + Google Sans). Dev API server at `server.ts`. Pages: Dashboard, Review, Skills, Settings, Hot Log, Warm Themes |

## Key patterns

- **MCP SDK**: `@modelcontextprotocol/sdk` v1.29.0. Server uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` with `server.tool()` (4-arg overload). Client uses `Client` from `@modelcontextprotocol/sdk/client/index.js` with `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`.
- **LLM calls**: All go through `LlmProvider` interface in `packages/core/src/llm/provider.ts`. Factory at `createProvider(config)`. Adapters for Anthropic, OpenAI, Gemini.
- **Testing**: Vitest. MCP integration tests use `InMemoryTransport.createLinkedPair()`. LLM calls mocked with `{ complete: vi.fn().mockResolvedValue("...") }`.
- **Vault**: All data in `~/OpenPulseAI/vault/`. Hot = raw logs, Warm = curated themes, Pending = `warm/_pending/*.json` awaiting approval, Cold = monthly archives. Sessions in `vault/sessions/`.
- **Skills**: SKILL.md files in `~/OpenPulseAI/skills/` (user) and `packages/skills/builtin/` (bundled). Frontmatter: name, description, schedule (cron), lookback, requires (bins, env). The runner extracts shell commands from the body, pre-executes them, injects outputs into an LLM prompt.
- **Config**: `~/OpenPulseAI/config.yaml` with themes and llm provider/model. Skills are filesystem-based, NOT in config.
- **UI**: No framework. Vanilla TS with Shoelace web components. Hash-based routing (`#dashboard`, `#skills`, etc). Dev API server in `packages/ui/server.ts` bridges the UI to the real vault filesystem. Tauri backend (Rust) not yet implemented — frontend works standalone.
- **ESM**: All packages use `"type": "module"`. No `require()`. Imports use `.js` extensions.
- **Cron parsing**: `cron-parser` v5 uses `CronExpressionParser.parse()` (not v4's `parseExpression`).

## Build & test

```bash
pnpm install && pnpm build    # Build all packages
pnpm vitest run               # Run all tests (~292 tests)
pnpm build:sea:mcp            # SEA binary for MCP server (needs Node from nodejs.org)
pnpm build:sea:dream           # SEA binary for Dream Pipeline
```

## Dev server

```bash
cd packages/ui
npx tsx server.ts &            # API server on :3001
npx vite --port 1420 &        # UI on :1420
```

## Current state

Fully functional but experimental:
- All 5 packages build and pass tests
- MCP server works with Claude Desktop / Claude Code
- Skills system discovers and runs SKILL.md files (3 bundled: google-daily-digest, github-activity, weekly-rollup)
- Control Center UI works in browser with live vault data
- SEA binaries build on Node 22+
- Tauri desktop wrapper pending (needs Rust)

## Design docs

- `docs/superpowers/specs/2026-04-03-connector-proxy-system.md` — original connector design
- `docs/superpowers/specs/2026-04-04-skills-system-design.md` — skills system design (current)
- `docs/superpowers/plans/` — implementation plans

## What's next

See README.md project status checklist. Key items: Tauri desktop wrapper, Slack/Teams bot, embedding-based search, skill composition.
