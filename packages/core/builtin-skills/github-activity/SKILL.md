---
name: github-activity
description: Watch specific repos (github.com or GitHub Enterprise) — commits, PRs, reviews, issue comments, releases
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

1. Run `gh auth status >/dev/null 2>&1 || echo "!! gh not authenticated — run: gh auth login"; printf '%s\n' "{{github_repo_urls}}" | grep -vE '^\{\{|^[[:space:]]*$' | tr ',' '\n' | sed 's/[[:space:]]//g; s/\.git$//' | grep -v '^$' | while IFS= read -r url; do host=$(echo "$url" | sed 's|https://||; s|/.*||'); repo=$(echo "$url" | sed 's|https://[^/]*/||'); [ -z "$repo" ] && continue; echo "=== $repo ==="; HARG=""; [ "$host" != "github.com" ] && HARG="--hostname $host"; echo "--- Commits ---"; gh api $HARG --paginate "repos/$repo/commits?per_page=100&since={{since_iso}}" --jq '.[] | {sha: .sha[0:7], msg: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}' 2>/dev/null; echo "--- PRs updated ---"; gh api $HARG --paginate "repos/$repo/pulls?state=all&per_page=100&sort=updated&direction=desc" --jq '.[] | select(.updated_at > "{{since_iso}}") | {number, title, state, user: .user.login, updated: .updated_at}' 2>/dev/null; echo "--- Releases ---"; gh api $HARG --paginate "repos/$repo/releases?per_page=30" --jq '.[] | select(.published_at != null and .published_at > "{{since_iso}}") | {name, tag: .tag_name, published: .published_at}' 2>/dev/null; done; echo "=== my-cross-repo-activity ==="; echo "--- PRs I reviewed ---"; gh api --paginate "search/issues?q=reviewed-by:@me+updated:>{{since_date}}&per_page=50" --jq '.items[]? | {number, title, repo: (.repository_url | split("/") | .[-2:] | join("/")), url: .html_url, updated: .updated_at, state}' 2>/dev/null; echo "--- Issues/PRs I commented on ---"; gh api --paginate "search/issues?q=commenter:@me+updated:>{{since_date}}&per_page=50" --jq '.items[]? | {number, title, repo: (.repository_url | split("/") | .[-2:] | join("/")), url: .html_url, updated: .updated_at, state}' 2>/dev/null; true` to collect commits, PRs, reviews, comments, and releases since the last run.

If the command produced no output or only the not-authenticated marker, write exactly what the output says. Do NOT invent data.

Otherwise, produce a factual Markdown summary. Use one level-3 heading per repo that had activity (format: ### owner/repo), plus one ### My cross-repo activity section for reviews/comments I made on other repos. Under each repo cover:
- **Commits:** sha, one-line message, author, date. If none, skip the bullet.
- **Pull Requests:** number, title, state, author, updated date. If none, skip.
- **Releases:** name/tag and date. If none, skip.

Under the My cross-repo activity section:
- **Reviews:** PR number, title, repo, state.
- **Comments:** number, title, repo, state.

Lead with the most active repo. Include PR/issue numbers. Skip obvious noise (bot/dependency bumps) unless that's all there is.

## Output Format

One level-3 heading (### owner/repo) per repo, plus ### My cross-repo activity if any. Keep it factual — only what the command output shows.
