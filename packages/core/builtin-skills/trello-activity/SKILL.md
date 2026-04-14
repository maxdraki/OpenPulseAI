---
name: trello-activity
description: Track Trello board activity — card moves, comments, and due dates
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [curl]
setup_guide: "Get your API key from [trello.com/app-key](https://trello.com/app-key). Then click the Token link on that page to generate a token. Find your board ID from the board URL — it's the alphanumeric string after /b/ (e.g. trello.com/b/**aBcDeFg**/board-name)."
config:
  - key: trello_api_key
    label: API key
    type: text
  - key: trello_token
    label: Token
    type: text
  - key: trello_board_id
    label: Board ID
    type: text
---

## Instructions

1. Run `curl -s "https://api.trello.com/1/boards/{{trello_board_id}}/actions?key={{trello_api_key}}&token={{trello_token}}&limit=50&filter=createCard,updateCard,commentCard,moveCardToBoard,addMemberToCard"` to get recent board activity
2. Run `curl -s "https://api.trello.com/1/boards/{{trello_board_id}}/cards?key={{trello_api_key}}&token={{trello_token}}&fields=name,dateLastActivity,due,idList,shortUrl&filter=open"` to get current open cards
3. Run `curl -s "https://api.trello.com/1/boards/{{trello_board_id}}/lists?key={{trello_api_key}}&token={{trello_token}}&fields=name"` to get list names for context

Summarise ONLY what the API returns. Focus on:
- Cards that were created, moved, or updated in the last 24 hours
- New comments on cards
- Cards with upcoming due dates
- Who did what (if member info is available)

If the API returns an error or empty results, report that clearly. Do not invent card names or activity.

## Output Format

### Trello Activity
- **Cards moved:** [list moves with from→to columns]
- **New cards:** [recently created]
- **Comments:** [notable discussions]
- **Due soon:** [cards with approaching due dates]
