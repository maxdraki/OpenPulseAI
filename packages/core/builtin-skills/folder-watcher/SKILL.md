---
name: folder-watcher
description: Track recently modified files across your project directories and summarize changes
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

1. Run `find {{watch_paths}} -maxdepth 3 -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" -o -name "*.json" | head -500` to get a baseline of project files
2. Run `find {{watch_paths}} -maxdepth 3 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" \) -mtime -1 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | head -100` to find files modified in the last 24 hours
3. Run `ls -lt {{watch_paths}}/*/  2>/dev/null | head -30` to see recently active project directories
4. Summarize which projects had file activity, what types of files changed, and any notable patterns.

Before returning your answer, verify every file path and project name against the command output above. Do not invent or assume any file names or project names that don't appear in the output.

## Output Format

Write a concise Markdown summary organized by project directory. Note which projects were active and what kinds of changes occurred. If no recent changes are found, say so clearly.
