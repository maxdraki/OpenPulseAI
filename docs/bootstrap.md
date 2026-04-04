# Bootstrap — paste this into your first Claude Code prompt

---

I'm continuing development on OpenPulseAI. Read CLAUDE.md for full project context.

## How I work

- I prefer you use your judgment and move fast. Don't ask for permission on obvious things.
- Use subagent-driven development for multi-task implementation (dispatch parallel agents where possible).
- Use the superpowers skills (brainstorming, writing-plans, subagent-driven-development) for any non-trivial work.
- For the UI: we use Shoelace web components, DM Sans + JetBrains Mono fonts, dark theme with color-coded vault layers (amber=hot, teal=warm, violet=pending). No React — vanilla TS only.
- For the logo: animated pulse-line SVG in the sidebar (see index.html).
- Skills follow the AgentSkills.io standard (SKILL.md format). We support `npx skillsadd` from skills.sh registry.
- BYO LLM — always keep the provider abstraction, never hardcode to one provider.
- The project uses pnpm workspaces, ESM throughout, Vitest for tests, TDD approach.

## Current priorities

Check README.md project status checklist for what's done and what's pending. Key next items:
- Tauri desktop wrapper (Rust backend for the Control Center)
- Slack/Teams bot that calls `chat_with_pulse` MCP tool
- Embedding-based search upgrade for `query_memory`
- More bundled skills (Slack, Jira, Linear, etc.)
- End-to-end testing of the full flow: skill runs → dream synthesizes → user approves → stakeholder queries

## Quick commands

```bash
pnpm install && pnpm build           # Build everything
pnpm vitest run                       # Run all tests
cd packages/ui && pnpm dev            # Start Control Center
node packages/skills/dist/index.js --list   # List skills
```
