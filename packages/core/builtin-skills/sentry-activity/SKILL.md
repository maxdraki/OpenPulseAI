---
name: sentry-activity
description: Track Sentry errors — unresolved issues, new events, and regression alerts
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Create an Auth Token at [Sentry Auth Tokens](https://sentry.io/settings/auth-tokens/) with `project:read` and `event:read` scopes. Your org slug is in your Sentry URL: sentry.io/organizations/**your-org**/. If you use self-hosted Sentry, change the domain to your instance."
config:
  - key: sentry_token
    label: Auth token
    type: text
  - key: sentry_org
    label: Organization slug
    type: text
  - key: sentry_domain
    label: Sentry domain
    type: text
    default: sentry.io
---

## Instructions

1. Run `curl -s -H "Authorization: Bearer {{sentry_token}}" "https://{{sentry_domain}}/api/0/organizations/{{sentry_org}}/issues/?query=is:unresolved&sort=date&limit=20"` to get unresolved issues sorted by most recent

2. Run `curl -s -H "Authorization: Bearer {{sentry_token}}" "https://{{sentry_domain}}/api/0/organizations/{{sentry_org}}/issues/?query=firstSeen:>{{since_iso}}&sort=date&limit=20"` to get newly appeared issues in the last 24 hours

3. Run `curl -s -H "Authorization: Bearer {{sentry_token}}" "https://{{sentry_domain}}/api/0/organizations/{{sentry_org}}/issues/?query=is:regression&sort=date&limit=10"` to get regressions (previously resolved issues that reappeared)

Summarise ONLY what the API returns. Focus on:
- New errors that appeared in the last 24 hours
- High-frequency unresolved issues (by event count)
- Regressions (issues that came back after being resolved)
- Which projects are affected

If the API returns an error or authentication fails, report that clearly. Do not invent error messages or issue IDs.

## Output Format

### Sentry Activity
- **New errors:** [issues first seen in lookback period]
- **Top unresolved:** [highest-frequency open issues]
- **Regressions:** [resolved issues that reappeared]
- **Projects affected:** [which projects have activity]
