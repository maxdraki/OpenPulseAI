---
name: google-daily-digest
description: Summarise Gmail and Calendar activity since the last run using gogcli
schedule: "0 22 * * *"
lookback: 24h
requires:
  bins: [gog]
  env: [GOG_ACCOUNT]
config:
  - key: gog_account
    label: Google account email
    type: text
---

## Context

You are collecting the user's Google Workspace activity since the last run. The shell commands already filter by date so you do not need to guess the window.

## Instructions

1. Run `gog gmail search "after:{{since_date}}" --max 100 --json` to list emails received since the last run.
2. Run `gog calendar events list --from "{{since_date}}" --to "{{now_date}}" --json` to list calendar events across the full collection window (not just today).
3. For each email: extract subject, participants, and any decisions or action items. Skip newsletters, automated notifications, and marketing.
4. For each calendar event: note title, attendees, and whether the user attended or declined.
5. Group findings by theme (project, person, topic).

## Output Format

Single Markdown document. Start with `### Since {{since_date}}`. Focus on what's actionable or status-relevant. Be concrete — include subject lines, PR or ticket refs mentioned in emails, and event titles verbatim.
