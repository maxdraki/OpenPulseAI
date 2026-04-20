---
name: folder-watcher
description: Track file changes and git history across your project directories since the last run
schedule: "0 19 * * *"
lookback: 24h
first_run_lookback: 7d
requires:
  bins: [find, git]
setup_guide: "Add the directories you want to watch. Use the folder picker or type paths manually. Separate multiple paths with newlines. If a path contains multiple git repos (e.g. ~/Documents/GitHub), their git history is also collected."
config:
  - key: watch_paths
    label: Directories to watch
    default: ~/Documents/GitHub
    type: paths
---

## Instructions

1. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.toml" -o -name "*.css" -o -name "*.html" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.pptx" -o -name "*.pdf" -o -name "*.txt" -o -name "*.csv" \) -newermt "{{since_datetime}}" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | grep -v __pycache__ | grep -v target | grep -v .tsbuildinfo | sort` to find files modified since last run (exact timestamp, not day-boundary).
2. Run `find {{watch_paths}} -maxdepth 4 \( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.rs" -o -name "*.md" -o -name "*.txt" -o -name "*.csv" \) -newermt "{{since_datetime}}" 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | head -40 | while IFS= read -r f; do echo "=== $f ==="; head -30 "$f" 2>/dev/null; echo ""; done | head -800` to peek at the first ~30 lines of each modified text file (while-read handles long CloudStorage paths that would overflow xargs).
3. Run `for p in {{watch_paths}}; do if [ -d "$p/.git" ]; then echo "=== git: $p ==="; git -C "$p" log --since="{{since_iso}}" --name-status --pretty=format:"%h %s (%an) %ai" 2>/dev/null | head -120; else for repo in "$p"/*/; do [ -d "${repo}.git" ] || continue; rel="${repo%/}"; rel="${rel##*/}"; echo "=== git: $rel ==="; git -C "$repo" log --since="{{since_iso}}" --name-status --pretty=format:"%h %s (%an) %ai" 2>/dev/null | head -80; done; fi; done` to capture commits — including deletions and renames — inside each watched git repo.

If every command returns NO output, write "No file modifications detected since last run." and stop.

Otherwise, summarise ONLY what appears in the output. Group findings into `### [ProjectName]` sections using these rules:
- If a file is inside a subdirectory of a watch root, use the **first subdirectory name** (e.g. `OneDrive/Projects/DataPlatform/x.pptx` → `DataPlatform`).
- For code repos under `Documents/GitHub`, the repo folder name is the project name.
- The git-log output is the source of truth for commits, renames, and deletions — cite SHAs where useful.
- NEVER use a cloud-storage or generic parent folder (OneDrive, Dropbox, iCloud, Documents, Downloads) as the heading — step one level deeper.

For each project:
- **Modified:** filenames (not full paths).
- **Commits:** SHA + message (if git log output contained entries).
- **Deleted / renamed:** any files `D` or `R`-marked in the git log.
- **Scope:** small tweak, feature, refactor, etc.

RULES:
- ONLY mention projects that appear in the output of the three commands above.
- NEVER invent files or commits not in the output.
- If unsure about a file's purpose, list it without guessing.

## Output Format

`### [ProjectName]` per project. Factual bullet points only.
