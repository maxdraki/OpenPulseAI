# Contributing a Data Source Collector

OpenPulse collectors are SKILL.md files — natural language instructions that tell the system what data to fetch and how to summarize it. No code to write, no SDK to learn. If you can write a curl command, you can build a collector.

## How collectors work

1. The **runner** extracts shell commands from backtick blocks in your SKILL.md
2. Commands execute via `bash -c` with a 30-second timeout per command
3. Command outputs are sent to the user's configured LLM
4. The LLM writes a journal summary based on your instructions
5. The summary feeds into the Dream Pipeline for wiki-style knowledge pages

## SKILL.md format

```yaml
---
name: my-service-activity
description: One-line summary of what this collector tracks
schedule: "0 18 * * 1-5"          # cron expression (default schedule)
lookback: 24h                      # how far back to look
requires:
  bins: [curl]                     # required CLI tools
setup_guide: "Get your API key from [Service Settings](https://...). Paste it below."
config:
  - key: api_key
    label: API key
    type: text                     # text (default), path, or paths
  - key: project_id
    label: Project ID
    type: text
    default: ""                    # optional — fields with defaults aren't required
---

## Instructions

1. Run `curl -s -H "Authorization: Bearer {{api_key}}" "https://api.example.com/activity?since=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"` to get recent activity

Summarise ONLY what the API returns. Focus on:
- Key changes and updates
- New items created
- Notable activity

If the API returns an error, report it clearly. Do not invent data.

## Output Format

### Service Activity
- **Changes:** [what changed]
- **New items:** [what was created]
```

## Frontmatter reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase kebab-case identifier (e.g. `gitlab-activity`) |
| `description` | Yes | One-line human-readable summary |
| `schedule` | No | Cron expression for default schedule. Omit for manual-only |
| `lookback` | No | How far back to look: `24h`, `7d`, `1w`. Default: `24h` |
| `requires.bins` | No | CLI tools needed (e.g. `[curl]`, `[gh]`, `[linear]`) |
| `requires.env` | No | Env vars to pass through to commands (e.g. `[LINEAR_API_KEY]`) |
| `setup_guide` | Yes* | Markdown text shown in setup dialog. Include links to credential pages |
| `config` | No | User-configurable fields with `{{placeholder}}` substitution |

*Strongly recommended for any collector that needs credentials.

## Config field types

| Type | Description | Example |
|------|-------------|---------|
| `text` | Single-line string (API keys, IDs, domains) | API key, project ID |
| `path` | Single directory path (shows folder picker) | Watch directory |
| `paths` | Multiple paths, newline-separated (shows folder picker) | Multiple watch dirs |

## Writing shell commands

Commands go in backticks in the Instructions section. The runner extracts and executes them.

### Do

- Use `curl -s` (silent mode) for API calls
- Use `{{config_key}}` for user-configurable values
- Use cross-platform date: `$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%d)`
- Include `2>/dev/null` on optional commands
- Prefer dedicated CLIs when available: `linear issue query ...` over raw GraphQL

### Don't

- Don't use `-v` or `--verbose` on curl (leaks auth headers in logs)
- Don't use write operations (`-X POST/PUT/DELETE`) unless the API requires it for reads (e.g. GraphQL)
- Don't hardcode credentials — always use `{{config_key}}`
- Don't use `rm`, `mv`, or any destructive commands
- Don't pipe to `bash` or `sh`

## The setup_guide field

This is what users see when they click on your collector in the UI. Make it actionable:

```yaml
setup_guide: "Create a Personal Access Token at [GitLab Settings](https://gitlab.com/-/user_settings/personal_access_tokens) with `read_api` scope. Your domain is where you access GitLab (e.g. **gitlab.com** or **gitlab.mycompany.com**)."
```

Supported markdown in setup guides:
- `[link text](https://url)` — clickable links (open in new tab)
- `**bold text**` — bold
- `` `inline code` `` — code styling

## CLI tool fallback pattern

If a dedicated CLI exists for your service, use it with a curl fallback:

```markdown
1. Run `my-cli list --recent 2>/dev/null || curl -s -H "Authorization: Bearer {{api_key}}" "https://api.example.com/items"` to get recent items
```

The `||` means: try the CLI first, fall back to curl if it's not installed. This way the collector works for everyone (curl is universal) but gives better output for users who install the CLI.

## Security

All non-builtin collectors go through a security scanner that blocks:
- Network requests to non-trusted domains
- Destructive commands (`rm -rf`, `mkfs`, etc.)
- Credential access (`$API_KEY`, `~/.ssh`, etc.)
- Privilege escalation (`sudo`, `su`)
- Pipe-to-shell patterns (`| bash`)

If your collector calls a new API domain, it will be flagged. Builtin collectors (in `packages/core/builtin-skills/`) bypass the scanner. Community collectors submitted via PR are reviewed for safety before merging.

## Testing your collector

1. Place your SKILL.md in `~/OpenPulseAI/skills/my-collector/SKILL.md`
2. Fill in credentials: create `~/OpenPulseAI/vault/skill-config/my-collector.json`
   ```json
   {"api_key": "your-key-here"}
   ```
3. Check it's discovered: `node packages/core/dist/skills/cli.js --list`
4. Run it: `node packages/core/dist/skills/cli.js --run my-collector`
5. Check the output: `cat ~/OpenPulseAI/vault/hot/$(date +%Y-%m-%d).md`

## Submitting

1. Fork the repo
2. Add your collector to `packages/core/builtin-skills/<name>/SKILL.md`
3. Test it with real credentials
4. Submit a PR with:
   - The SKILL.md file
   - A brief description of what service it connects to
   - Confirmation you tested it against a real account
5. Add the service domain to `TRUSTED_DOMAINS` in `packages/core/src/skills/security.ts` if needed

## Examples

See the existing collectors for reference:
- `packages/core/builtin-skills/github-activity/` — uses `gh` CLI
- `packages/core/builtin-skills/linear-activity/` — CLI + curl fallback with GraphQL
- `packages/core/builtin-skills/trello-activity/` — curl with query-param auth
- `packages/core/builtin-skills/jira-activity/` — curl with Basic auth
- `packages/core/builtin-skills/slack-activity/` — curl with Bearer token
