# OpenPulseAI Setup Guide

## Quick Start

1. Install dependencies:
   ```bash
   pnpm install && pnpm build
   ```

2. Initialize the vault:
   ```bash
   mkdir -p ~/OpenPulseAI/vault/{hot/ingest,warm/_pending,cold}
   ```

3. Create config:
   ```bash
   cat > ~/OpenPulseAI/config.yaml << 'EOF'
   themes:
     - project-auth
     - hiring
     - infrastructure
   llm:
     provider: anthropic    # or: openai, gemini
     model: claude-sonnet-4-5-20250929  # or: gpt-4o, gemini-2.0-flash
   EOF
   ```

## Configure Claude Desktop

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openpulse": {
      "command": "node",
      "args": ["/path/to/OpenPulseAI/packages/mcp-server/dist/index.js"],
      "env": {
        "OPENPULSE_VAULT": "/home/YOUR_USER/OpenPulseAI"
      }
    }
  }
}
```

## Configure Claude Code

Add to `~/.claude/settings.json` under `mcpServers`:

```json
"openpulse": {
  "command": "node",
  "args": ["/path/to/OpenPulseAI/packages/mcp-server/dist/index.js"],
  "env": {
    "OPENPULSE_VAULT": "/home/YOUR_USER/OpenPulseAI"
  }
}
```

## Run the Dream Pipeline

Manually:
```bash
ANTHROPIC_API_KEY=sk-... node packages/dream/dist/index.js
```

Via cron (2 AM daily):
```cron
0 2 * * * ANTHROPIC_API_KEY=sk-... OPENPULSE_VAULT=$HOME/OpenPulseAI node /path/to/packages/dream/dist/index.js >> /tmp/openpulse-dream.log 2>&1
```

Or trigger from the Control Center UI (Dashboard > Run Dream Pipeline).

## Launch the Control Center

Development:
```bash
cd packages/ui && pnpm dev
```

## LLM Provider Setup

OpenPulseAI supports BYO LLM — choose your provider:

| Provider | Config value | Env var | Models |
|----------|-------------|---------|--------|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-5-20250929, etc. |
| OpenAI | `openai` | `OPENAI_API_KEY` | gpt-4o, gpt-4o-mini, etc. |
| Google | `gemini` | `GEMINI_API_KEY` | gemini-2.0-flash, etc. |

API keys can be set via environment variables or stored securely in the Control Center (Settings > API Key).

## Build SEA Binaries

```bash
pnpm build
pnpm build:sea:mcp    # produces dist/mcp-server
pnpm build:sea:dream   # produces dist/dream
```

The SEA binaries are self-contained — no Node.js installation required.
