---
name: github-activity
description: Summarize recent GitHub activity — PRs, reviews, commits, and notifications
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
---

## Instructions

1. Run `gh pr list --author @me --state all --json title,state,updatedAt,url --limit 20` for your PRs
2. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 10` for PRs you reviewed
3. Run `gh api notifications --method GET` for recent notifications
4. Summarize: PRs opened, merged, or reviewed. Issues commented on. Repos you were active in.

## Output Format

Write a concise Markdown summary organized by: PRs, Reviews, and Notable Activity.
