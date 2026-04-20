---
name: linear-activity
description: Track Linear issues — status changes, new issues, comments, and cycle progress
schedule: "0 18 * * 1-5"
lookback: 24h
first_run_lookback: 7d
requires:
  bins: [curl]
setup_guide: "Create a Personal API key at [Linear API Settings](https://linear.app/settings/api). Select read-only scope. If you also install the [Linear CLI](https://github.com/schpet/linear-cli), the collector will use it automatically for richer output."
config:
  - key: linear_api_key
    label: API key
    type: text
---

## Instructions

Collect recent Linear activity. Try the CLI first, fall back to curl.

1. Run `linear issue query --all-teams --all-states --updated-after {{since_date}} --no-pager --limit 50 2>/dev/null || curl -s -H "Authorization: {{linear_api_key}}" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d '{"query":"{ issues(first: 50, orderBy: updatedAt, filter: { updatedAt: { gte: \"{{since_iso}}\" } }) { nodes { identifier title state { name type } priority assignee { name } labels { nodes { name } } updatedAt createdAt } } }"}'` to get recently updated issues

2. Run `curl -s -H "Authorization: {{linear_api_key}}" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d '{"query":"{ comments(first: 30, orderBy: updatedAt, filter: { updatedAt: { gte: \"{{since_iso}}\" } }) { nodes { body issue { identifier title } user { name } createdAt } } }"}'` to get recent comments

3. Run `curl -s -H "Authorization: {{linear_api_key}}" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d '{"query":"{ cycles(first: 5, orderBy: updatedAt, filter: { isActive: { eq: true } }) { nodes { name number progress startsAt endsAt issues { nodes { identifier title state { name } } } } } }"}'` to get active cycle progress

Summarise ONLY what the commands return. Focus on:
- Issues that changed state (e.g. Backlog -> In Progress, In Progress -> Done)
- Newly created issues
- Comments and discussions
- Active cycle/sprint progress

If the API returns an error or authentication fails, report that clearly. Do not invent issue identifiers or status transitions.

## Output Format

### Linear Activity
- **Status changes:** [issues that moved between states]
- **New issues:** [recently created]
- **Comments:** [notable discussions]
- **Cycle progress:** [active sprint metrics if available]
