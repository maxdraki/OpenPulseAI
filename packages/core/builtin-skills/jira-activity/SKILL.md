---
name: jira-activity
description: Summarise recent Jira issues, sprint progress, and comments
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Create an API token at [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Your domain is the subdomain you use to access Jira (e.g. **myteam**.atlassian.net). The project key is the prefix on your issue IDs (e.g. **ENG**-123). You can monitor multiple projects by entering comma-separated keys with no spaces (e.g. **ENG,VDP**)."
config:
  - key: jira_domain
    label: Jira domain (e.g. myteam.atlassian.net)
    type: domain
  - key: jira_email
    label: Account email
    type: text
  - key: jira_api_token
    label: API token
    type: text
  - key: jira_project_key
    label: Project keys, comma-separated, no spaces (e.g. ENG,VDP)
    type: text
---

## Instructions

1. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search/jql?jql=project+IN+({{jira_project_key}})+AND+updated>="{{since_date}}"&fields=summary,status,assignee,priority,comment,project&maxResults=50"` to get recently updated issues
2. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search/jql?jql=project+IN+({{jira_project_key}})+AND+status+changed+during+("{{since_date}}",now())&fields=summary,status,assignee,project&maxResults=30"` to get issues that changed status

Summarise ONLY what the API returns. Focus on:
- Issues that changed status (e.g. In Progress → Done)
- New comments on issues
- Newly created issues
- High priority items

If the API returns an error or authentication fails, report that clearly. Do not invent issue numbers or status transitions.

## Output Format

### [Project Name] Activity (use the full project name from the API response, not the key)
- **Status changes:** [issue transitions]
- **New issues:** [recently created]
- **Comments:** [notable discussions]
- **High priority:** [urgent items]
