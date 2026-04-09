---
name: weekly-rollup
description: Generate a stakeholder-friendly weekly status summary from your approved themes
lookback: 7d
config:
  - key: vault_path
    label: Vault path
    default: ~/OpenPulseAI
    type: path
---

## Instructions

1. Run `ls {{vault_path}}/vault/warm/*.md` to find all theme files
2. Run `cat {{vault_path}}/vault/warm/*.md` to read all theme content
3. For each theme, identify key changes and status updates from the past week
4. Organize by priority — what's most important for stakeholders first
5. Write a concise weekly status update

Before returning your answer, verify every project name, PR number, and factual claim against the theme content above. Do not invent any details.

## Output Format

# Weekly Status

## Highlights
- Top 3-5 things stakeholders should know

## By Theme
### [theme-name]
- Current status
- Key changes this week
