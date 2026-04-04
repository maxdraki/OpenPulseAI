# Tauri Desktop Wrapper — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Approach:** Hybrid — native Rust vault I/O + SEA sidecar binaries

## Goal

Package OpenPulseAI's Control Center as a lightweight, self-contained macOS desktop app using Tauri v2. No Node.js required at runtime. The existing Vite + vanilla TS + Shoelace frontend runs inside Tauri's native webview with a Rust backend handling vault file I/O and spawning SEA sidecars for complex operations (dream pipeline, skill runner).

## Decisions

- **Tauri v2** (stable, current) — not v1.
- **macOS only** for initial release. Windows/Linux added later via CI matrix.
- **Vault location hardcoded** to `~/OpenPulseAI/`. Configurable later if needed.
- **SEA sidecars** bundled inside the .app for dream pipeline and skill runner. No Node on PATH required.
- **Type-safe Tauri imports** — `tauri-bridge.ts` uses `@tauri-apps/api/core` instead of `window.__TAURI__` cast.

## Project Structure

```
src-tauri/
├── Cargo.toml              # Tauri v2 + deps (serde, serde_yaml, glob, chrono, dirs)
├── tauri.conf.json          # Window config, sidecar declarations, bundle ID
├── capabilities/
│   └── default.json         # Permissions: shell (sidecars), fs (vault), path
├── src/
│   ├── main.rs              # Entry point, register all commands
│   ├── vault.rs             # Vault path resolution, hot/warm/pending file I/O
│   ├── config.rs            # Parse ~/OpenPulseAI/config.yaml
│   ├── skills.rs            # Discover SKILL.md files, parse frontmatter
│   └── sidecar.rs           # Spawn SEA binaries (dream, skill runner)
├── icons/                   # App icons (generated from existing logo SVG)
└── sidecars/                # SEA binaries copied here at build time
    ├── openpulse-dream
    └── openpulse-skills
```

## Command Mapping

Each function in `packages/ui/src/lib/tauri-bridge.ts` maps to a `#[tauri::command]` in Rust.

### Native Rust (vault file I/O)

| Bridge function | Rust command | Implementation |
|---|---|---|
| `getVaultHealth()` | `get_vault_health` | Count files in `vault/hot/`, `vault/warm/`, `vault/warm/_pending/` |
| `getHotEntries()` | `get_hot_entries` | Read `vault/hot/*.md`, parse timestamp/log/theme/source from frontmatter |
| `getWarmThemes()` | `get_warm_themes` | Read `vault/warm/*.md` (excluding `_pending/`), parse theme/content/lastUpdated |
| `listPendingUpdates()` | `list_pending_updates` | Read `vault/warm/_pending/*.json`, deserialize into PendingUpdate structs |
| `approveUpdate(id)` | `approve_update` | Move pending JSON -> write to warm markdown file |
| `rejectUpdate(id)` | `reject_update` | Delete the pending JSON file |
| `getLlmConfig()` | `get_llm_config` | Parse `config.yaml`, return provider + model |
| `saveLlmSettings(...)` | `save_llm_settings` | Read config.yaml, update llm section, write back |
| `getVaultPath()` | `get_vault_path` | Return `~/OpenPulseAI` resolved to absolute path |
| `getSkills()` | `get_skills` | Glob SKILL.md files from `skills/` + `builtin/`, parse YAML frontmatter, check bin/env requirements |

### Sidecar (SEA binaries)

| Bridge function | Sidecar | Args |
|---|---|---|
| `triggerDream()` | `openpulse-dream` | (none) |
| `runSkillNow(name)` | `openpulse-skills` | `--run <name>` |
| `installSkill(repo)` | `openpulse-skills` | `--install <repo>` |
| `removeSkill(name)` | `openpulse-skills` | `--remove <name>` |

Sidecars capture stdout and return it to the frontend. Errors are caught and surfaced as Tauri command errors (rejected promises).

## Tauri Configuration

### `tauri.conf.json`

- Bundle identifier: `com.openpulseai.desktop`
- Window: 1100x750, title "OpenPulse", resizable, min 800x600
- Dev URL: `http://localhost:1420`
- Frontend dist: `../packages/ui/dist`
- External binaries: `["sidecars/openpulse-dream", "sidecars/openpulse-skills"]`

### Capabilities (`capabilities/default.json`)

- `shell:allow-execute` — scoped to the two declared sidecars only
- `fs:allow-read` / `fs:allow-write` — scoped to `~/OpenPulseAI/` only
- `path:default` — for resolving home directory

No network permissions. Everything is local filesystem.

## Rust Implementation

### Dependencies

| Crate | Purpose |
|---|---|
| `tauri` v2 | Framework + plugins (shell, fs, path) |
| `serde` + `serde_json` + `serde_yaml` | JSON/YAML serialization |
| `glob` | File discovery (`vault/hot/*.md`, etc.) |
| `chrono` | Timestamp parsing and sorting |
| `dirs` | Resolve `~` to home directory |

### Frontmatter parsing

Hot entries, warm themes, and SKILL.md files use `---` delimited YAML frontmatter followed by markdown content. A shared utility splits on the first two `---` lines, runs `serde_yaml::from_str` on the frontmatter, and returns the rest as content.

### Skill eligibility

`skills.rs` checks `requires.bins` via `std::process::Command::new("which")` and `requires.env` via `std::env::var`. Same logic as `packages/ui/server.ts`.

### Error handling

All commands return `Result<T, String>`. Tauri serializes `Err(msg)` into a rejected promise on the frontend.

### State

Vault path (`~/OpenPulseAI` resolved once at startup) stored in `tauri::State<AppState>`. No database, no caches — every command reads fresh from disk.

## Changes to Existing Code

### No changes needed

- `packages/ui/src/pages/*` — all use tauri-bridge, no direct fetch
- `packages/ui/vite.config.ts` — already has `envPrefix: ["TAURI_"]` and external `@tauri-apps/api/core`
- `packages/core`, `packages/mcp-server`, `packages/dream`, `packages/skills` — untouched

### Changes

- **`packages/ui/src/lib/tauri-bridge.ts`** — Switch from `(window as any).__TAURI__.core.invoke` to typed import from `@tauri-apps/api/core`. Update `isTauri` detection to check `__TAURI_INTERNALS__`.
- **`packages/ui/package.json`** — Add `@tauri-apps/api` as dev dependency.
- **Root `package.json`** — Add `dev:desktop` and `build:desktop` scripts.
- **`.gitignore`** — Add `src-tauri/target/`, `src-tauri/sidecars/`.

## Build Integration

### Development

```bash
pnpm dev:desktop
# Runs: pnpm dev:ui (Vite on :1420) + cargo tauri dev
```

### Production build

```bash
pnpm build:desktop
# 1. pnpm build                    (all TS packages)
# 2. pnpm build:sea:dream          (SEA binary)
# 3. pnpm build:sea:skills         (SEA binary — needs new script)
# 4. cp dist/dream src-tauri/sidecars/openpulse-dream
#    cp dist/skills src-tauri/sidecars/openpulse-skills
# 5. cargo tauri build             (produces .app / .dmg)
```

### New SEA target

`packages/skills` needs a CLI entry point and corresponding `build:sea:skills` script (same pattern as dream/mcp-server).

## Bundle Size Estimate

- Tauri runtime + Rust binary: ~8-12MB
- Frontend assets (Vite bundle + Shoelace): ~2-3MB
- SEA sidecars (dream + skills): ~160-220MB (each embeds Node runtime)
- **Total .app: ~170-235MB**

The SEA sidecars dominate the size. Future optimization: share a single Node runtime between both sidecars, or incrementally rewrite them in Rust.

## Out of Scope (v1)

- Windows/Linux builds
- Configurable vault location
- Auto-updates
- Menu bar / system tray integration
- Tauri deep links or URL scheme handling
- Replacing SEA sidecars with native Rust
