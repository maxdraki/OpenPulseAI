---
name: folder-watcher
description: Track recently modified files across your project directories and summarize what changed
schedule: "0 19 * * *"
lookback: 24h
requires:
  bins: [find]
setup_guide: "Add the directories you want to watch for file changes. Use the folder picker or type paths manually. Separate multiple paths with newlines."
config:
  - key: watch_paths
    label: Directories to watch
    default: ~/Documents/GitHub
    type: paths
---

## Instructions

1. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.toml" -o -name "*.css" -o -name "*.html" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.pptx" -o -name "*.pdf" -o -name "*.txt" -o -name "*.csv" \) -mtime -{{since_days}} 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | grep -v __pycache__ | grep -v target | grep -v .tsbuildinfo | sort` to find files modified since last run
2. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" -o -name "*.txt" -o -name "*.csv" \) -mtime -{{since_days}} 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | xargs -I{} sh -c 'echo "=== {} ===" && head -3 "{}"' 2>/dev/null | head -150` to peek at the first few lines of modified text files (skips binary Office formats)

If the commands return NO output, write "No file modifications detected since last run." and stop. Do not speculate about what might have changed.

If the commands return results, summarize ONLY the files listed in the output. For each project directory that has modified files:
- List the specific files that changed (from the find output)
- Describe what the files likely do based on their names and the head output
- Estimate the scope: small tweak, feature addition, or major refactoring

RULES:
- ONLY mention projects that appear in the find output
- NEVER mention projects that had zero files in the output
- NEVER invent file names or changes not shown in the command output
- If unsure about a file's purpose, just list it without guessing

## Output Format

### [ProjectName]
- **Modified:** `file1.ts`, `file2.ts`
- **Scope:** [description]
