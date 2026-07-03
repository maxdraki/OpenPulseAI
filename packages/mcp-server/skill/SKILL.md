---
name: openpulse-memory
description: Use this skill when the user references their OpenPulse work journal or knowledge base — phrases like "my work journal", "what did I work on", "what do I know about X", "summarize my week", or "OpenPulse" — to connect to the OpenPulse MCP server and query or record activity in it.
---

# OpenPulse Memory

OpenPulse is a local-first work journal and knowledge base. Collectors record
raw activity; an LLM periodically synthesizes it into curated, cross-linked
wiki-style theme pages. This skill teaches how to use the OpenPulse MCP
server well from a Claude client.

## Connecting

**stdio (Claude Desktop, Claude Code)** — the server is added as a local MCP
server that Claude spawns itself:

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

No token needed — Claude Desktop/Code spawns the process directly, so it's
inherently trusted.

**HTTPS (remote / custom connector)** — run `node packages/mcp-server/dist/http.js
--port 3002`, which prints a connector URL of the form
`https://localhost:3002/mcp?token=<64 hex chars>`. The token is generated on
first run and persisted at `~/OpenPulseAI/mcp-token` (mode `0600`) — every
`/mcp` request must include it, either as the `?token=` query param or as
`Authorization: Bearer <token>`. Delete that file to rotate the token.

## The narrow-then-read pattern

Prefer this two-step flow over guessing a theme name or dumping everything:

1. **`search_index`** — ranked full-text search (theme, heading, snippet,
   score) across every synthesized theme page. Use this first, with a query
   describing what you're looking for.
2. **`read_theme`** — once you know the theme name from step 1 (or from the
   `openpulse://index` resource), fetch its complete Markdown content.

This keeps context small: you only pull the full page(s) you actually need,
rather than every theme in the vault. `query_memory` is an older single-step
alternative (keyword match, returns full content directly) — still available,
but `search_index` + `read_theme` scale better as the vault grows.

For open-ended, conversational questions where you want the model itself to
decide how to search across turns, use `chat_with_pulse` instead (requires
an LLM provider configured on the OpenPulse side).

The `openpulse://index` MCP resource is the wiki map (`vault/warm/index.md`)
— read it to see what themes exist before searching, or to orient a new
conversation.

Two prompts are also registered to jump-start common tasks:
- `summarize_my_week` — walks through search_index/read_theme over recent
  activity plus `log.md` to produce a status summary.
- `what_do_i_know_about` (argument: `topic`) — runs the narrow-then-read flow
  for a specific topic.

## Recording activity

Use **`record_activity`** whenever something worth remembering just
happened — what you (or the user) just did, decided, or shipped. Accepts:
- `log` (required): the activity description.
- `theme` (optional): steers downstream classification.
- `source` (optional): a label for where this came from (e.g. `"claude-code"`).

Use **`ingest_document`** instead for whole documents (specs, design docs,
meeting notes) rather than short activity notes.

`submit_update` still works but is deprecated — it's a thin alias for
`record_activity` kept only for backward compatibility with older clients.

## The review-gated write model

Nothing written via these tools is published directly to the queryable wiki.
`record_activity`/`ingest_document`/`submit_update` only write to the raw
"hot" journal layer. A separate Dream Pipeline (scheduled or manually
triggered, not part of this MCP surface) classifies and synthesizes hot
entries into warm theme pages — and even then, proposed changes land in a
**pending review queue** (`vault/warm/_pending/`) that a human must approve
in the OpenPulse Control Center before they become part of the searchable
knowledge base. So: recording activity here is always safe and non-destructive
— it never silently overwrites or auto-publishes anything.
