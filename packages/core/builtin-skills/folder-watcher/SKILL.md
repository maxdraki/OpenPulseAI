---
name: folder-watcher
description: Track recently modified files across your project directories and summarize what changed
schedule: "0 19 * * *"
lookback: 24h
requires:
  bins: [find]
config:
  - key: watch_paths
    label: Directories to watch
    default: ~/Documents/GitHub
    type: paths
---

## Instructions

1. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.toml" -o -name "*.css" -o -name "*.html" \) -mtime -1 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | grep -v __pycache__ | grep -v target | sort` to find all source files modified in the last 24 hours
2. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" \) -mtime -1 -exec wc -l {} + 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | tail -20` to get line counts of modified files
3. Run `find {{watch_paths}} -maxdepth 4 -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -mtime -1 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | xargs -I{} sh -c 'echo "=== {} ===" && head -5 "{}"' 2>/dev/null | head -200` to peek at the first few lines of modified source files (to understand what they do)

Focus ONLY on files that were actually modified. Do NOT mention inactive projects or projects with no changes. Your job is to describe WHAT changed, not what didn't.

For each project with modifications:
- List the specific files that changed
- Describe what the files likely do based on their names and paths (e.g. "runner.ts — skill execution engine", "security.ts — new threat scanner")
- Note any new files vs modified files if you can tell from context
- Estimate the scope: small tweak, feature addition, or major refactoring

Before returning your answer, verify every file path and project name against the command output above. Do not invent or assume any file names or project names that don't appear in the output.

## Output Format

Write a concise Markdown journal entry. Only mention projects with actual changes. Example:

### OpenPulseAI
- **Modified:** `runner.ts` (skill execution), `security.ts` (new — threat scanner), `server.ts` (API routes)
- **Scope:** Feature addition — added security scanning to skill system
- **Files changed:** 8 source files, ~400 lines
