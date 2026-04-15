---
name: github-activity
description: Summarize recent GitHub activity — commits, PRs, reviews, issues, and notifications
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
setup_guide: "Requires the [GitHub CLI](https://cli.github.com). After installing, run `gh auth login` in your terminal to authenticate. No API key needed — the CLI manages auth."
config:
  - key: github_repos
    label: "GitHub.com repos to watch (comma-separated owner/repo, e.g. myorg/api)"
    type: text
    default: ","
  - key: github_enterprise_host
    label: "GitHub Enterprise hostname (e.g. github.mycompany.com, optional)"
    type: domain
    default: "github.com"
  - key: github_enterprise_repos
    label: "Enterprise repos to watch (comma-separated owner/repo, optional)"
    type: text
    default: ","
---

## Instructions

1. Run `gh api events --limit 100 --jq '[.[] | select(.type == "PushEvent" or .type == "PullRequestEvent" or .type == "IssuesEvent" or .type == "CreateEvent" or .type == "PullRequestReviewEvent" or .type == "IssueCommentEvent") | {type, repo: .repo.name, created_at, payload_action: .payload.action, ref: .payload.ref, commits: (.payload.commits // [] | map(.message))}]'` for recent activity across all repos
2. Run `gh pr list --author @me --state all --json title,state,updatedAt,url,repository --limit 20` for your PRs
3. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 10` for PRs you reviewed
4. Run `gh api notifications --method GET --jq '[.[] | {reason, subject_title: .subject.title, repo: .repository.full_name, updated_at}]'` for recent notifications
5. Run `gh api user/repos --jq '[.[] | select(.pushed_at > (now - 86400 | todate)) | {name: .full_name, pushed_at, default_branch}]'` to find repos with recent pushes
6. Run `printf '%s\n' "{{github_repos}}" | grep -vE '^\{\{|^[,[:space:]]*$' | tr ',' '\n' | grep -v '^[[:space:]]*$' | while IFS= read -r repo; do repo=$(echo "$repo" | tr -d ' '); echo "=== $repo ==="; gh api "repos/$repo/commits?per_page=10" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; done; true` for recent commits and PRs in your watched github.com repos (skipped when none configured)
7. Run `printf '%s\n' "{{github_enterprise_repos}}" | grep -vE '^\{\{|^[,[:space:]]*$' | tr ',' '\n' | grep -v '^[[:space:]]*$' | while IFS= read -r repo; do repo=$(echo "$repo" | tr -d ' '); echo "=== $repo ({{github_enterprise_host}}) ==="; gh api "repos/$repo/commits?per_page=10" --hostname "{{github_enterprise_host}}" --jq '[.[] | {sha: .sha[0:7], message: (.commit.message | split("\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null; gh api "repos/$repo/pulls?state=all&per_page=10&sort=updated" --hostname "{{github_enterprise_host}}" --jq '[.[] | {number, title, state, user: .user.login, updated: .updated_at}]' 2>/dev/null; done; true` for recent commits and PRs in your watched enterprise repos (skipped when none configured)

When commands 6 and 7 return per-repo data, organise that output first, grouped by repo (`### owner/repo`), with commits and open PRs for each. If both commands produce no output, fall back to summarising the general activity from commands 1–5 as before.

Summarize all activity organized by:
- **Commits**: repos you pushed to, number of commits, key commit messages
- **Pull Requests**: opened, merged, or reviewed
- **Issues**: opened, commented on, or closed
- **Notifications**: notable items worth mentioning

## Output Format

Write a concise Markdown summary. Lead with the most significant activity. Include repo names and link-worthy references (PR numbers, issue numbers). Skip routine bot notifications and automated actions.
