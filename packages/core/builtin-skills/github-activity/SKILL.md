---
name: github-activity
description: Watch specific repos (github.com or GitHub Enterprise) — commits and pull requests
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
setup_guide: "Requires the [GitHub CLI](https://cli.github.com). After installing, run `gh auth login` in your terminal to authenticate. No API key needed — the CLI manages auth."
config:
  - key: github_repo_urls
    label: "Repo URLs to watch (comma-separated, paste from the Code button on GitHub)"
    type: text
    default: " "
---

## Instructions

1. Run `printf '%s\n' "{{github_repo_urls}}" | grep -vE '^\{\{|^[[:space:]]*$' | tr ',' '\n' | sed 's/[[:space:]]//g; s/\.git$//' | grep -v '^$' | while IFS= read -r url; do host=$(echo "$url" | sed 's|https://||; s|/.*||'); repo=$(echo "$url" | sed 's|https://[^/]*/||'); [ -z "$repo" ] && continue; echo "=== $repo ==="; if [ "$host" = "github.com" ]; then gh api "repos/$repo/commits?per_page=50&since={{since_iso}}" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; else gh api "repos/$repo/commits?per_page=50&since={{since_iso}}" --hostname "$host" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --hostname "$host" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; fi; done; true` for commits since last run and recent PRs in your watched repos

If the command produced no output, write: "No repos configured — add repo URLs in the github-activity settings."

Otherwise, write a concise Markdown summary grouped by repo (one level-3 heading per repo). For each repo cover:
- **Commits**: commits since last run — sha, message, author, date. If a repo had no commits in this period, write "No commits since last run."
- **Pull Requests**: open PRs and any recently updated ones

Lead with the most active repo. Include PR numbers. Skip noise (e.g. automated dependency bumps) unless nothing else happened.

## Output Format

One level-3 heading (### owner/repo) per repo. Under each: commits and PRs. Keep it factual — only what the command output shows.
