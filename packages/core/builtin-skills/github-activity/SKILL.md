---
name: github-activity
description: Summarize recent GitHub activity — commits, PRs, reviews, issues, and notifications
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

1. Run `gh api events --limit 100 --jq '[.[] | select(.type == "PushEvent" or .type == "PullRequestEvent" or .type == "IssuesEvent" or .type == "CreateEvent" or .type == "PullRequestReviewEvent" or .type == "IssueCommentEvent") | {type, repo: .repo.name, created_at, payload_action: .payload.action, ref: .payload.ref, commits: (.payload.commits // [] | map(.message))}]'` for recent activity across all repos
2. Run `gh pr list --author @me --state all --json title,state,updatedAt,url,repository --limit 20` for your PRs
3. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 10` for PRs you reviewed
4. Run `gh api notifications --method GET --jq '[.[] | {reason, subject_title: .subject.title, repo: .repository.full_name, updated_at}]'` for recent notifications
5. Run `gh api user/repos --jq '[.[] | select(.pushed_at > (now - 86400 | todate)) | {name: .full_name, pushed_at, default_branch}]'` to find repos with recent pushes
6. Run `printf '%s\n' "{{github_repo_urls}}" | grep -vE '^\{\{|^[[:space:]]*$' | tr ',' '\n' | sed 's/[[:space:]]//g; s/\.git$//' | grep -v '^$' | while IFS= read -r url; do host=$(echo "$url" | sed 's|https://||; s|/.*||'); repo=$(echo "$url" | sed 's|https://[^/]*/||'); [ -z "$repo" ] && continue; echo "=== $repo ==="; if [ "$host" = "github.com" ]; then gh api "repos/$repo/commits?per_page=10" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; else gh api "repos/$repo/commits?per_page=10" --hostname "$host" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --hostname "$host" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; fi; done; true` for recent commits and PRs in your watched repos (skipped when none configured)

When command 6 returns per-repo data, organise that output first, grouped by repo (one level-3 heading per repo), with commits and open PRs for each. If command 6 produces no output, fall back to summarising the general activity from commands 1–5 as before.

Summarize all activity organized by:
- **Commits**: repos you pushed to, number of commits, key commit messages
- **Pull Requests**: opened, merged, or reviewed
- **Issues**: opened, commented on, or closed
- **Notifications**: notable items worth mentioning

## Output Format

Write a concise Markdown summary. Lead with the most significant activity. Include repo names and link-worthy references (PR numbers, issue numbers). Skip routine bot notifications and automated actions.
