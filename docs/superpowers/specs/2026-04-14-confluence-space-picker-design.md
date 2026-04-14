# Confluence Space Picker — Design

**Date:** 2026-04-14  
**Status:** Approved

## Problem

The `confluence_space_keys` config field is a plain text input where users must type space keys manually (e.g. `ATWG,VDP`). This is error-prone: keys are not visible in the Confluence UI, easy to mistype, and case-sensitive. Users have already hit this (entering a tiny-URL page ID instead of a space key).

## Goal

Replace the text input with a searchable checkbox list that discovers available spaces from the user's Confluence instance, so users pick spaces by name rather than typing keys.

## Scope

- **In scope:** Space picker in the configure panel (gear icon on skill card) for `confluence-activity` only
- **Out of scope:** Generic picker field type, Add modal picker, other skills

## Design

### Server Endpoint

`POST /api/confluence-activity/spaces`

Request body:
```json
{ "domain": "myteam.atlassian.net", "email": "user@example.com", "token": "ATATT3x..." }
```

Response:
```json
[{ "key": "ATWG", "name": "AI Tooling Working Group" }, ...]
```

- Proxies to `GET /wiki/rest/api/space?limit=250&type=global` using HTTP Basic auth
- Returns only `key` and `name` — no credentials stored or logged
- Returns 401 if Confluence rejects the credentials, 500 on network failure

### Bridge Function

`fetchConfluenceSpaces(domain, email, token): Promise<{ key: string; name: string }[]>`

Thin wrapper in `tauri-bridge.ts` over `apiPost("/confluence-activity/spaces", { domain, email, token })`.

### Space Picker UI

Replaces the plain `<input>` for the `confluence_space_keys` field in `renderSkillCard`'s config panel. Detects the field by `field.key === "confluence_space_keys"`.

**Structure:**
```
[Discover Spaces ▼]          ← button, reads sibling inputs for credentials
[Search spaces...    ]        ← filter input, hidden until spaces loaded
┌────────────────────────────┐
│ ✓ ATWG  AI Tooling WG     │  ← checkbox list, scrollable (max-height)
│ ☐ VDP   VDP Platform      │
│ ☐ DA    Data & Analytics  │
└────────────────────────────┘
<input type="hidden" data-config-key="confluence_space_keys" value="ATWG">
```

**Credential reading:** On button click, the picker walks up to the `configFields` container and queries `input[data-config-key="confluence_domain"]`, `confluence_email`, `confluence_api_token` from sibling rows.

**Selection → storage:** On each checkbox change, the hidden input value is updated to the comma-separated list of checked keys. The existing save button logic (`querySelectorAll("input[data-config-key]")`) picks it up with no changes.

**Pre-selection:** On load, the hidden input is initialised from `savedConfig["confluence_space_keys"]` and checkboxes are pre-ticked for those keys.

**Error states:**
- Loading: button shows spinner, disabled
- 401: "Could not authenticate — check your credentials"
- Network error: "Could not reach Confluence"
- Empty list: "No spaces found"

## Files to Modify

| File | Change |
|------|--------|
| `packages/ui/server.ts` | Add `POST /api/confluence-activity/spaces` endpoint |
| `packages/ui/src/lib/tauri-bridge.ts` | Add `fetchConfluenceSpaces()` function |
| `packages/ui/src/pages/data-sources.ts` | Replace `confluence_space_keys` text input with space picker |

## No Core Changes

No changes to `types.ts`, `loader.ts`, `runner.ts`, or `SKILL.md`.
