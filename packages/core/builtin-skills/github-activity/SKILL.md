---
name: github-activity
description: Summarize recent GitHub activity — commits, PRs, reviews, issues, and notifications
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
---

## Instructions

1. Run `gh api events --limit 100 --jq '[.[] | select(.type == "PushEvent" or .type == "PullRequestEvent" or .type == "IssuesEvent" or .type == "CreateEvent" or .type == "PullRequestReviewEvent" or .type == "IssueCommentEvent") | {type, repo: .repo.name, created_at, payload_action: .payload.action, ref: .payload.ref, commits: (.payload.commits // [] | map(.message))}]'` for recent activity across all repos
2. Run `gh pr list --author @me --state all --json title,state,updatedAt,url,repository --limit 20` for your PRs
3. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 10` for PRs you reviewed
4. Run `gh api notifications --method GET --jq '[.[] | {reason, subject_title: .subject.title, repo: .repository.full_name, updated_at}]'` for recent notifications
5. Run `gh api user/repos --jq '[.[] | select(.pushed_at > (now - 86400 | todate)) | {name: .full_name, pushed_at, default_branch}]'` to find repos with recent pushes

Summarize all activity organized by:
- **Commits**: repos you pushed to, number of commits, key commit messages
- **Pull Requests**: opened, merged, or reviewed
- **Issues**: opened, commented on, or closed
- **Notifications**: notable items worth mentioning

## Output Format

Write a concise Markdown summary. Lead with the most significant activity. Include repo names and link-worthy references (PR numbers, issue numbers). Skip routine bot notifications and automated actions.
