---
name: google-daily-digest
description: Summarize today's Gmail and Calendar activity using gogcli
schedule: "0 22 * * *"
lookback: 24h
requires:
  bins: [gog]
---

## Context

You are collecting the user's daily Google Workspace activity to produce a concise summary for the OpenPulse vault.

## Instructions

1. Run `gog gmail search 'newer_than:1d' --max 50 --json` to get today's emails
2. Run `gog calendar events list --from today --to tomorrow --json` to get today's calendar events
3. For each email thread, extract: subject, participants, key decisions or action items
4. For each calendar event, note: title, attendees, whether attended or declined
5. Group findings by theme (project names, people, topics)

## Output Format

Write the summary as a single Markdown document. Start with a date header. Focus on what's actionable or status-relevant. Skip newsletters, automated notifications, and marketing emails.
