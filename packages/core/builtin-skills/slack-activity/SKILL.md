---
name: slack-activity
description: Collect recent Slack messages and mentions from key channels
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps), add Bot Token Scopes `channels:history` and `users:read`, install to your workspace, then copy the Bot User OAuth Token (starts with xoxb-). To find channel IDs, right-click a channel in Slack > View channel details > copy the ID at the bottom."
config:
  - key: slack_bot_token
    label: Bot token (xoxb-...)
    type: text
  - key: slack_channel_ids
    label: Channel ID (one channel per data source)
    type: text
---

## Instructions

1. Run `curl -s -H "Authorization: Bearer {{slack_bot_token}}" "https://slack.com/api/conversations.history?channel={{slack_channel_ids}}&limit=100&oldest=$(date -v-24H +%s 2>/dev/null || date -d '24 hours ago' +%s)"` to get recent messages from the channel
2. Run `curl -s -H "Authorization: Bearer {{slack_bot_token}}" "https://slack.com/api/users.list?limit=200"` to resolve user IDs to display names

Summarise ONLY what the API returns. Focus on:
- Key decisions or announcements
- Action items or requests
- Important discussions and their outcomes
- Mentions of the user

Skip automated bot messages, join/leave notifications, and routine status updates. If the API returns an error or the token is invalid, report that clearly.

## Output Format

### Slack Activity
**#channel-name:**
- [Key discussion or decision]
- [Action item if any]

**#other-channel:**
- [Summary]
