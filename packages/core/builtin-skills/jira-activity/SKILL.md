---
name: jira-activity
description: Summarise recent Jira issues, sprint progress, and comments
schedule: "0 18 * * 1-5"
lookback: 24h
first_run_lookback: 7d
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

1. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search/jql?jql=project+IN+({{jira_project_key}})+AND+updated>="{{since_date}}"&fields=summary,description,status,assignee,priority,comment,project,labels,issuetype&maxResults=50"` to get recently updated issues with their descriptions and comments
2. Run `curl -s -u "{{jira_email}}:{{jira_api_token}}" -H "Accept: application/json" "https://{{jira_domain}}/rest/api/3/search/jql?jql=project+IN+({{jira_project_key}})+AND+status+changed+during+("{{since_date}}",now())&fields=summary,status,assignee,project&maxResults=30"` to get issues that changed status (metadata only — descriptions come from query 1)

Summarise ONLY what the API returns, **preserving the actual text of descriptions and comments** (paraphrase where verbose, but keep the substance). Focus on:
- Issues that changed status — quote the status transition (e.g. "In Progress → Done")
- New comments on issues — include 1-2 sentences of the comment body from `comment.comments[*].body` (Jira returns Atlassian Document Format — extract the text content from `content[*].content[*].text` nodes)
- Newly created issues — include the description body (from `description.content[*].content[*].text`) summarised to 2-3 sentences
- High priority items

For the issue description and comment bodies: Jira's API returns ADF (Atlassian Document Format) as a nested JSON structure. Walk `description.content[]` and `comment.comments[*].body.content[]` to extract the actual text. Skip rich-text formatting; preserve the prose.

If the API returns an error or authentication fails, report that clearly. Do not invent issue numbers, descriptions, or status transitions.

## Output Format

### [Project Name] Activity (use the full project name from the API response, not the key)
- **Status changes:** issue ID, title, transition (e.g. VDP-143 Create Appian output views: In Progress → Done)
- **New issues:** issue ID, title, 2-3 sentence summary of the description
- **Comments:** issue ID, commenter, 1-2 sentence paraphrase of the comment body
- **High priority:** urgent items with 1-line description
