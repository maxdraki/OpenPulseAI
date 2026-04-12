---
name: jira-activity
description: Summarise recent Jira issues, sprint progress, and comments
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
config:
  - key: jira_domain
    label: Jira domain (e.g. myteam.atlassian.net)
    type: text
  - key: jira_email
    label: Jira account email
    type: text
  - key: jira_api_token
    label: Jira API token (from id.atlassian.com/manage-profile/security/api-tokens)
    type: text
  - key: jira_project_key
    label: Project key (e.g. ENG, PROD)
    type: text
---

## Instructions

1. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search?jql=project={{jira_project_key}}+AND+updated>=-1d&fields=summary,status,assignee,priority,comment&maxResults=50"` to get recently updated issues
2. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search?jql=project={{jira_project_key}}+AND+status+changed+during+(-1d,now())&fields=summary,status,assignee&maxResults=30"` to get issues that changed status

Summarise ONLY what the API returns. Focus on:
- Issues that changed status (e.g. In Progress → Done)
- New comments on issues
- Newly created issues
- High priority items

If the API returns an error or authentication fails, report that clearly. Do not invent issue numbers or status transitions.

## Output Format

### Jira Activity — {{jira_project_key}}
- **Status changes:** [issue transitions]
- **New issues:** [recently created]
- **Comments:** [notable discussions]
- **High priority:** [urgent items]
