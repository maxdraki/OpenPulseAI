---
name: todoist-activity
description: Track Todoist tasks — completed, created, and upcoming due dates
schedule: "0 20 * * *"
lookback: 24h
first_run_lookback: 7d
requires:
  bins: [curl]
setup_guide: "Find your API token in Todoist at [Settings > Integrations > Developer](https://app.todoist.com/app/settings/integrations/developer). Copy the token and paste it below."
config:
  - key: todoist_token
    label: API token
    type: text
---

## Instructions

1. Run `curl -s -H "Authorization: Bearer {{todoist_token}}" "https://api.todoist.com/sync/v9/completed/get_all?since={{since_iso}}&limit=50"` to get recently completed tasks

2. Run `curl -s -H "Authorization: Bearer {{todoist_token}}" "https://api.todoist.com/rest/v2/tasks?filter=created after: -1 days"` to get recently created tasks

3. Run `curl -s -H "Authorization: Bearer {{todoist_token}}" "https://api.todoist.com/rest/v2/tasks?filter=due before: +2 days"` to get tasks due soon

Summarise ONLY what the API returns. Focus on:
- Tasks completed today (what got done)
- New tasks created (what was added to the backlog)
- Upcoming due dates (what's coming up)

If the API returns an error or authentication fails, report that clearly. Do not invent task names or projects.

## Output Format

### Todoist Activity
- **Completed:** [tasks finished today]
- **New tasks:** [recently added]
- **Due soon:** [upcoming deadlines]
