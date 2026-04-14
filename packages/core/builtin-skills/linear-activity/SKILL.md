---
name: linear-activity
description: Track Linear issues — status changes, new issues, comments, and cycle progress
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
config:
  - key: linear_api_key
    label: Linear API key (Settings > API > Personal API keys)
    type: text
---

## Instructions

Collect recent Linear activity. Try the CLI first, fall back to curl.

1. Run `linear issue query --all-teams --all-states --updated-after $(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%d) --no-pager --limit 50 2>/dev/null || curl -s -H "Authorization: {{linear_api_key}}" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d '{"query":"{ issues(first: 50, orderBy: updatedAt, filter: { updatedAt: { gte: \"'$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)'\" } }) { nodes { identifier title state { name type } priority assignee { name } labels { nodes { name } } updatedAt createdAt } } }"}'` to get recently updated issues

2. Run `curl -s -H "Authorization: {{linear_api_key}}" -H "Content-Type: application/json" -X POST https://api.linear.app/graphql -d '{"query":"{ comments(first: 30, orderBy: updatedAt, filter: { updatedAt: { gte: \"'$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)'\" } }) { nodes { body issue { identifier title } user { name } createdAt } } }"}'` to get recent comments

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
