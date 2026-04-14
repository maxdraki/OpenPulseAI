---
name: confluence-activity
description: Summarise recently updated Confluence pages across one or more spaces
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Create an API token at [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Your domain is the subdomain you use to access Confluence (e.g. **myteam**.atlassian.net). To find a space key: open the space in Confluence, look at the URL — it's the uppercase code after `/wiki/spaces/` (e.g. atlassian.net/wiki/spaces/**ENG**/pages/...). You can also find it in Space Settings → Space Details. Monitor multiple spaces by entering comma-separated keys with no spaces (e.g. **ENG,DOCS,TEAM**)."
config:
  - key: confluence_domain
    label: Confluence domain (e.g. myteam.atlassian.net)
    type: domain
  - key: confluence_email
    label: Account email
    type: text
  - key: confluence_api_token
    label: API token
    type: text
  - key: confluence_space_keys
    label: Space keys, comma-separated, no spaces (e.g. ENG,DOCS)
    type: text
---

## Instructions

1. Run `SPACES="\"$(echo '{{confluence_space_keys}}' | sed 's/,/","/g')\"" && curl -s -u "{{confluence_email}}:{{confluence_api_token}}" -H "Accept: application/json" --get --data-urlencode "cql=space IN ($SPACES) AND type=page AND lastModified >= \"-1d\" ORDER BY lastModified DESC" --data-urlencode "expand=body.export_view,version,history.lastUpdated" --data-urlencode "limit=10" "https://{{confluence_domain}}/wiki/rest/api/content/search"` to get recently updated pages

Summarise ONLY what the API returns. For each page:
- Read the `title` and `space.name` to identify the page and which space it belongs to
- Note who last edited the page and when (from `version.by.displayName` and `version.when`)
- Read the `body.export_view.value` HTML, ignoring all markup tags, and write a 2-3 sentence summary of what the page covers
- Skip pages where the body is empty or trivially short (fewer than a few sentences)

Group output by space using the `space.name` from the API response. If a space had no page updates in the lookback period, omit it. If the API returns an error or authentication fails, report that clearly. Do not invent page titles, editor names, or content.

## Output Format

### [Space Name] — Recent Page Updates
- **[Page Title]** (updated by [Name], [date])
  [2-3 sentence summary of what the page covers]
