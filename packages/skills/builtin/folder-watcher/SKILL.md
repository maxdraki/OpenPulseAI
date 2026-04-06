---
name: folder-watcher
description: Track recently modified files in your projects directory and summarize changes
schedule: "0 19 * * *"
lookback: 24h
requires:
  bins: [find]
---

## Instructions

1. Run `find ~/Documents/GitHub -maxdepth 3 -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" -o -name "*.json" | head -500` to get a baseline of project files
2. Run `find ~/Documents/GitHub -maxdepth 3 -newer /tmp/openpulse-folder-marker -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | head -100` to find recently modified source files (this may return nothing on first run)
3. Run `ls -lt ~/Documents/GitHub/*/  2>/dev/null | head -30` to see recently active project directories
4. Summarize which projects had file activity, what types of files changed, and any notable patterns.

Before returning your answer, verify every file path and project name against the command output above. Do not invent or assume any file names or project names that don't appear in the output.

## Output Format

Write a concise Markdown summary organized by project directory. Note which projects were active and what kinds of changes occurred. If no recent changes are found, say so clearly.
