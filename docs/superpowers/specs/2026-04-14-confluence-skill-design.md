# Confluence Activity Skill — Design

**Date:** 2026-04-14  
**Status:** Approved

## Problem

OpenPulseAI has Jira and Trello collectors for Atlassian work tracking, but no collector for Confluence — which is often the primary source of truth for product specs, architecture decisions, and team documentation. Teams that write in Confluence have no way to surface recent page updates into the knowledge base.

## Goal

A `confluence-activity` builtin skill that collects recently updated Confluence pages across one or more spaces and summarises their content for the dream pipeline.

## Scope

- **In scope:** Recently modified pages, content summary, multi-space support
- **Out of scope:** Comments, blog posts, tasks, page restrictions, version diffing

## Design

### Credentials & Config

Four user-configurable fields, independent from the Jira skill:

| Key | Label | Type | Notes |
|-----|-------|------|-------|
| `confluence_domain` | Confluence domain | `domain` | Strips `https://` prefix automatically |
| `confluence_email` | Account email | `text` | Atlassian account email |
| `confluence_api_token` | API token | `text` | From id.atlassian.com |
| `confluence_space_keys` | Space keys (comma-separated, no spaces) | `text` | e.g. `ENG,DOCS,TEAM` |

The `domain` field type already exists in the runner (added for the Jira skill) — no core changes needed. Comma normalisation in `applyConfig` handles `ENG, DOCS` → `ENG,DOCS` automatically.

### Shell Commands

One curl call using Confluence's CQL (Confluence Query Language):

```
curl -s -u "{{confluence_email}}:{{confluence_api_token}}" -H "Accept: application/json" "https://{{confluence_domain}}/wiki/rest/api/content/search?cql=space+IN+({{confluence_space_keys}})+AND+type=page+AND+lastModified>=-1d+ORDER+BY+lastModified+DESC&expand=body.export_view,version,history.lastUpdated&limit=10"
```

- **CQL filter:** `space IN (KEY1,KEY2) AND type=page AND lastModified>=-1d` — scopes to the configured spaces, pages only, last 24 hours
- **`body.export_view`:** Clean HTML rendition the LLM can read directly (better than raw storage XML)
- **`version` + `history.lastUpdated`:** Last-modified-by user and timestamp
- **`limit=10`:** Caps response size across all spaces combined
- **Auth:** `-u email:token` (HTTP Basic, same as Jira)

No second call needed — space name is embedded in each page result's `space` field.

### LLM Synthesis

The LLM receives the full API response and is instructed to:

1. Group output by space (using the `space.name` field from each result)
2. For each page: extract title, last editor (`version.by.displayName`), and edit timestamp
3. Read the `body.export_view.value` HTML (ignoring markup) to write a 2–3 sentence summary of what the page covers
4. Skip pages where the body is empty or trivially short
5. Report clearly if the API returns an error or empty results — never invent content

### Output Format

```
### [Space Name] — Recent Page Updates
- **[Page Title]** (updated by [Name], [date])
  [2-3 sentence summary of the page content]
```

Multiple spaces produce multiple `### [Space Name]` sections.

### Classification

The dream pipeline classifier reads the LLM output. Page titles are typically project/product names, so the deterministic classifier (heading extraction) or LLM fallback will assign appropriate themes. No special-casing needed.

## Authentication

Atlassian API tokens are account-scoped (not per-product). The token from `id.atlassian.com/manage-profile/security/api-tokens` works for both Jira and Confluence on the same instance. Having separate config fields per skill is intentional — it avoids hidden coupling and supports connecting to a different Atlassian instance.

## No Core Changes Required

- `domain` field type: already in `types.ts`, `loader.ts`, `runner.ts`
- Comma normalisation: already in `applyConfig`
- Skill loader discovers new builtin skills automatically from the filesystem

## Files to Create

- `packages/core/builtin-skills/confluence-activity/SKILL.md`
