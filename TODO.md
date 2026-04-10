# OpenPulseAI — Backlog

Lightweight issue tracking. Updated as items are completed or added.

---

## High Priority

### Theme lint/health check
Periodic scan of warm themes for contradictions, stale claims, hallucinated content, and missing cross-references. Could be a "Health Check" button on the dashboard or an automated post-dream-pipeline step. Inspired by the Karpathy LLM Wiki pattern.
- **Status:** Not started
- **Why:** We've already hit hallucinated repos, lost history, and stale data in themes.

### Cross-theme classification
Dream pipeline currently classifies each entry into ONE theme. One source should update multiple related themes. E.g., a commit about encryption updates both `ai-development-logs` AND `security`.
- **Status:** Not started
- **Why:** Themes are siloed. Real work crosses boundaries.

### System tray (Tauri)
Tauri system tray indicator so the orchestrator runs when the window is closed.
- **Status:** Not started
- **Why:** Schedules only run while the window is open.

### Tauri Rust backend parity
Orchestrator commands in Rust, discovery/config end-to-end testing, system tray integration.
- **Status:** Partially done (vault commands, skills discovery exist in Rust; orchestrator, BYOM discovery not yet)
- **Why:** Dev server works but Tauri desktop needs parity for release.

### AI-guided skill setup
We have one-click binary install (brew/go), but interactive auth steps (gh auth login, gog auth manage) can't be automated with a button. Need an AI-guided walkthrough that detects what's needed, installs deps, walks through auth, and verifies everything works. Also: skill discovery/marketplace so users can browse available skills instead of pasting GitHub URLs.
- **Status:** Partially done (binary install buttons work; auth guidance and marketplace not started)
- **Why:** Installing binaries is step 1, but auth and configuration are the real barriers for new users.

---

## Medium Priority

### Queries become themes
When chat_with_pulse generates a valuable answer, offer to save it as a new theme or update an existing one. Currently chat responses are ephemeral.
- **Status:** Not started
- **Why:** Karpathy insight: "valuable answers become new wiki pages."

### Theme index
Auto-generated index.md cataloging all themes by category with cross-links.
- **Status:** Not started
- **Why:** As themes grow, discoverability matters.

### UI/UX polish
General refinement pass across all pages. Known items:
- Consistent spacing and padding across all card types
- Mobile/responsive layout (currently desktop-only)
- Better empty states with guided actions
- **Status:** Ongoing

### History page
Archive of previously approved reviews. Currently approved reviews just merge into themes with no audit trail.
- **Status:** Not started

---

## Lower Priority

### MCPorter integration
When a concrete skill needs MCP server access, integrate MCPorter as the client library instead of building our own.
- **Status:** Not started (unused MCP client was removed per code review)

### skills-ref validation
Use the canonical AgentSkills.io validator instead of hand-rolled SKILL.md parsing.
- **Status:** Not started

### Notifications
Alert when dream pipeline completes or a collector fails. Desktop notifications via Tauri, or in-app notification badge.
- **Status:** Not started

### Theme evolution
Revisit LLM-rewrite approach if themes still lose context despite improved prompts. May need a different strategy (append-only log + periodic full rewrite).
- **Status:** Monitoring — improved prompts shipped, watching results

---

## Completed

See git history and CLAUDE.md for full details. Key milestones:
- Tauri v2 desktop wrapper with Rust backend
- BYOM model picker (Anthropic/OpenAI/Gemini/Ollama)
- Scheduler & Orchestrator with visual Schedule page
- Skills refactoring: collapsed into core, added security hardening
- MCP connectivity: one-click Claude Desktop setup
- Logging, theming, markdown rendering, journal management
- Dashboard redesign with inline expandable themes
- Anti-hallucination prompts and theme history preservation
