---
name: gitlab-activity
description: Track GitLab activity — merge requests, commits, issues, and pipeline status
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Create a Personal Access Token at [GitLab Access Tokens](https://gitlab.com/-/user_settings/personal_access_tokens) with `read_api` scope. Your domain is where you access GitLab (e.g. **gitlab.com** or **gitlab.mycompany.com**)."
config:
  - key: gitlab_token
    label: Personal Access Token (read_api scope)
    type: text
  - key: gitlab_domain
    label: GitLab domain
    type: text
    default: gitlab.com
---

## Instructions

1. Run `curl -s -H "PRIVATE-TOKEN: {{gitlab_token}}" "https://{{gitlab_domain}}/api/v4/events?after={{since_date}}&per_page=50"` to get recent user events (pushes, comments, merge requests)

2. Run `curl -s -H "PRIVATE-TOKEN: {{gitlab_token}}" "https://{{gitlab_domain}}/api/v4/merge_requests?state=all&scope=all&updated_after={{since_iso}}&per_page=20"` to get recently updated merge requests

3. Run `curl -s -H "PRIVATE-TOKEN: {{gitlab_token}}" "https://{{gitlab_domain}}/api/v4/issues?state=all&scope=all&updated_after={{since_iso}}&per_page=20"` to get recently updated issues

Summarise ONLY what the API returns. Focus on:
- Merge requests opened, merged, or reviewed
- Commits pushed (repos and key messages)
- Issues created, updated, or closed
- Notable comments and discussions

If the API returns an error or authentication fails, report that clearly. Do not invent project names or MR numbers.

## Output Format

### GitLab Activity
- **Merge Requests:** [opened, merged, reviewed]
- **Commits:** [repos and key changes]
- **Issues:** [created, updated, closed]
- **Comments:** [notable discussions]
