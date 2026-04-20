---
name: obsidian-notes
description: Track recently modified notes across your Obsidian vaults and summarise what changed
schedule: "0 19 * * *"
lookback: 24h
first_run_lookback: 7d
requires:
  bins: [find, jq]
setup_guide: "Reads vaults from Obsidian's config (`~/Library/Application Support/obsidian/obsidian.json` on macOS; `$XDG_CONFIG_HOME/obsidian/obsidian.json` or `~/.config/obsidian/obsidian.json` on Linux). Leave **Vault filter** empty to include every vault Obsidian knows about, or list specific vault names (one per line, exact match on the vault folder name) to narrow down."
config:
  - key: obsidian_vault_filter
    label: Vaults (leave empty for all)
    default: ""
    type: text
---

## Instructions

1. Run `CONFIG="$HOME/Library/Application Support/obsidian/obsidian.json"; [ -f "$CONFIG" ] || CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json"; if [ ! -f "$CONFIG" ]; then echo "!! Obsidian config not found at $CONFIG"; exit 0; fi; VAULT_FILTER=$(printf '%s\n' "{{obsidian_vault_filter}}" | awk 'NF' | jq -R . | jq -s .); jq -r --argjson filter "$VAULT_FILTER" '.vaults // {} | to_entries[] | (.value.path | sub("/$"; "") | split("/") | last) as $name | if ($filter | length == 0) or any($filter[]; . == $name) then "\($name)\t\(.value.path)" else empty end' "$CONFIG" | while IFS=$'\t' read -r name path; do [ -d "$path" ] || continue; results=$(find "$path" -name "*.md" -newermt "{{since_iso}}" 2>/dev/null | grep -v "/\.obsidian/" | grep -v "/\.trash/" | sort); if [ -n "$results" ]; then echo "=== $name ==="; echo "$results"; fi; done` to list each vault and the notes modified since the last run.

2. Run `CONFIG="$HOME/Library/Application Support/obsidian/obsidian.json"; [ -f "$CONFIG" ] || CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/obsidian.json"; [ -f "$CONFIG" ] || exit 0; VAULT_FILTER=$(printf '%s\n' "{{obsidian_vault_filter}}" | awk 'NF' | jq -R . | jq -s .); jq -r --argjson filter "$VAULT_FILTER" '.vaults // {} | to_entries[] | (.value.path | sub("/$"; "") | split("/") | last) as $name | if ($filter | length == 0) or any($filter[]; . == $name) then "\($name)\t\(.value.path)" else empty end' "$CONFIG" | while IFS=$'\t' read -r name path; do [ -d "$path" ] || continue; find "$path" -name "*.md" -newermt "{{since_iso}}" 2>/dev/null | grep -v "/\.obsidian/" | grep -v "/\.trash/" | head -30 | xargs -I{} sh -c 'echo "=== {} ===" && head -3 "{}"' 2>/dev/null; done | head -200` to peek at the first few lines of each modified note for context.

If every command returns NO output (or only the `!! Obsidian config not found` marker), write "No Obsidian note modifications detected since last run." and stop.

Otherwise, group findings into `### <vault-name>` sections following these rules:

- Use exactly the vault names from the `=== <name> ===` markers in command 1.
- NEVER mention a vault with zero modified files.
- NEVER invent file names or changes not present in the output.
- If a note's purpose isn't obvious from the peeked content, list the filename without guessing.
- Prefer note titles over full paths (basenames, not full filesystem paths).
- Group related notes where it clarifies (e.g. multiple notes under a shared folder).

For each vault, summarise:

- **Modified:** filenames of changed notes
- **Scope:** short characterisation — new note, minor edit, batch tagging, daily note, meeting notes, etc., based on the peeked content

## Output Format

One `### <vault-name>` heading per vault that had activity. Factual bullet points only — no speculation about what wasn't in the output.
