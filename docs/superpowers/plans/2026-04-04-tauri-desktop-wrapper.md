# Tauri Desktop Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the OpenPulseAI Control Center as a self-contained macOS desktop app using Tauri v2 with native Rust vault I/O and SEA sidecar binaries.

**Architecture:** Tauri v2 wraps the existing Vite + vanilla TS frontend. The Rust backend handles vault file reads/writes natively (hot entries, warm themes, pending updates, config, skills discovery). Complex operations (dream pipeline, skill runner) delegate to bundled SEA sidecar binaries. The existing `tauri-bridge.ts` already has the dual-transport abstraction — we update it to use typed imports from `@tauri-apps/api/core`.

**Tech Stack:** Tauri v2, Rust, serde/serde_yaml/glob/chrono/dirs crates, Node.js SEA binaries

**Spec:** `docs/superpowers/specs/2026-04-04-tauri-desktop-wrapper.md`

---

## File Map

### New files (Rust backend)

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` | Tauri v2 dependencies |
| `src-tauri/tauri.conf.json` | Window, bundle, sidecar config |
| `src-tauri/capabilities/default.json` | Permissions (shell, fs, path) |
| `src-tauri/src/main.rs` | Entry point, register commands |
| `src-tauri/src/vault.rs` | Vault path, hot/warm/pending I/O |
| `src-tauri/src/config.rs` | Parse config.yaml |
| `src-tauri/src/skills.rs` | SKILL.md discovery, eligibility |
| `src-tauri/src/sidecar.rs` | Spawn SEA binaries |
| `src-tauri/build.rs` | Tauri build script (required by tauri-build) |

### Modified files

| File | Change |
|---|---|
| `packages/ui/src/lib/tauri-bridge.ts` | Switch to typed `@tauri-apps/api/core` import |
| `packages/ui/package.json` | Add `@tauri-apps/api` dev dependency |
| `package.json` (root) | Add `dev:desktop`, `build:desktop`, `build:sea:skills` scripts |
| `.gitignore` | Add `src-tauri/target/`, `src-tauri/sidecars/` |

---

## Task 1: Scaffold Tauri v2 project

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Modify: `.gitignore`

- [ ] **Step 1: Install Tauri CLI**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
cargo install tauri-cli --version "^2"
```

Expected: `tauri-cli` installed. Verify with `cargo tauri --version` outputting `tauri-cli 2.x.x`.

- [ ] **Step 2: Create `src-tauri/Cargo.toml`**

```toml
[package]
name = "openpulse-desktop"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
glob = "0.3"
chrono = { version = "0.4", features = ["serde"] }
dirs = "6"
```

- [ ] **Step 3: Create `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 4: Create `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/nicedoc/tauri-app/refs/heads/main/packages/config/schema/2.1.0.json",
  "productName": "OpenPulse",
  "version": "0.1.0",
  "identifier": "com.openpulseai.desktop",
  "build": {
    "frontendDist": "../packages/ui/dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "pnpm --filter @openpulse/ui dev:ui",
    "beforeBuildCommand": "pnpm --filter @openpulse/ui build"
  },
  "app": {
    "windows": [
      {
        "title": "OpenPulse",
        "width": 1100,
        "height": 750,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": [
      "sidecars/openpulse-dream",
      "sidecars/openpulse-skills"
    ]
  },
  "plugins": {
    "shell": {
      "open": false
    }
  }
}
```

- [ ] **Step 5: Create `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/nicedoc/tauri-app/refs/heads/main/packages/config/schema/2.1.0-capability.json",
  "identifier": "default",
  "description": "Default permissions for the OpenPulse desktop app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-execute",
    "shell:allow-spawn",
    "shell:allow-stdin-write"
  ]
}
```

- [ ] **Step 6: Create minimal `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Update `.gitignore`**

Add these lines to the existing `.gitignore`:

```
src-tauri/target/
src-tauri/sidecars/
```

- [ ] **Step 8: Generate app icons**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
mkdir -p src-tauri/icons
cargo tauri icon assets/openpulse-logo.svg
```

Expected: Icon files generated in `src-tauri/icons/`. If the SVG doesn't work directly, convert to PNG first:
```bash
# Fallback if SVG fails:
npx @aspect-build/rules_js//js:run_node -- -e "
const sharp = require('sharp');
sharp('assets/openpulse-logo.svg').resize(1024, 1024).png().toFile('src-tauri/icons/icon.png')
"
cargo tauri icon src-tauri/icons/icon.png
```

- [ ] **Step 9: Verify the scaffold compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors. Warnings about unused imports are fine.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/ .gitignore
git commit -m "feat(desktop): scaffold Tauri v2 project with shell plugin"
```

---

## Task 2: Implement vault.rs — path resolution and file counting

**Files:**
- Create: `src-tauri/src/vault.rs`
- Modify: `src-tauri/src/main.rs`

**Reference:** `packages/ui/server.ts:50-56` (vault-health), `packages/ui/server.ts:173-175` (vault-path)

- [ ] **Step 1: Create `src-tauri/src/vault.rs` with AppState and path helpers**

```rust
use std::path::PathBuf;
use std::fs;
use serde::Serialize;

pub struct AppState {
    pub vault_root: PathBuf,
}

impl AppState {
    pub fn new() -> Self {
        let home = dirs::home_dir().expect("Cannot resolve home directory");
        Self {
            vault_root: home.join("OpenPulseAI"),
        }
    }

    pub fn vault_dir(&self) -> PathBuf {
        self.vault_root.join("vault")
    }

    pub fn hot_dir(&self) -> PathBuf {
        self.vault_dir().join("hot")
    }

    pub fn warm_dir(&self) -> PathBuf {
        self.vault_dir().join("warm")
    }

    pub fn pending_dir(&self) -> PathBuf {
        self.warm_dir().join("_pending")
    }

    pub fn config_path(&self) -> PathBuf {
        self.vault_root.join("config.yaml")
    }
}

fn count_files(dir: &PathBuf, ext: &str) -> usize {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map_or(false, |x| x == ext)
                })
                .count()
        })
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHealth {
    pub hot_count: usize,
    pub warm_count: usize,
    pub pending_count: usize,
    pub vault_exists: bool,
}

#[tauri::command]
pub fn get_vault_health(state: tauri::State<'_, AppState>) -> Result<VaultHealth, String> {
    let vault_dir = state.vault_dir();
    Ok(VaultHealth {
        hot_count: count_files(&state.hot_dir(), "md"),
        warm_count: count_files(&state.warm_dir(), "md"),
        pending_count: count_files(&state.pending_dir(), "json"),
        vault_exists: vault_dir.is_dir(),
    })
}

#[tauri::command]
pub fn get_vault_path(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.vault_root.to_string_lossy().into_owned())
}
```

- [ ] **Step 2: Wire vault commands into `main.rs`**

Replace `src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(vault::AppState::new())
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/vault.rs src-tauri/src/main.rs
git commit -m "feat(desktop): add vault health and path commands"
```

---

## Task 3: Implement vault.rs — hot entries parsing

**Files:**
- Modify: `src-tauri/src/vault.rs`

**Reference:** `packages/ui/server.ts:177-211` — hot entries are `vault/hot/YYYY-MM-DD.md` files. Each file contains blocks separated by `\n---\n`. Each block has a `## TIMESTAMP` heading, optional `**Theme:**` and `**Source:**` lines, and content lines.

- [ ] **Step 1: Add frontmatter utility and HotEntry struct to `vault.rs`**

Append to `src-tauri/src/vault.rs`:

```rust
use std::cmp::Reverse;

#[derive(Serialize)]
pub struct HotEntry {
    pub timestamp: String,
    pub log: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[tauri::command]
pub fn get_hot_entries(state: tauri::State<'_, AppState>) -> Result<Vec<HotEntry>, String> {
    let hot_dir = state.hot_dir();
    let mut entries: Vec<HotEntry> = Vec::new();

    let files = match fs::read_dir(&hot_dir) {
        Ok(f) => f,
        Err(_) => return Ok(entries),
    };

    let date_re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}\.md$").unwrap();
    let ts_re = regex::Regex::new(r"^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)").unwrap();
    let theme_re = regex::Regex::new(r"^\*\*Theme:\*\*\s*(.+)").unwrap();
    let source_re = regex::Regex::new(r"^\*\*Source:\*\*\s*(.+)").unwrap();

    for entry in files.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !date_re.is_match(&name_str) {
            continue;
        }

        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for block in content.split("\n---\n") {
            let block = block.trim();
            if block.is_empty() {
                continue;
            }

            let mut timestamp = None;
            let mut theme = None;
            let mut source = None;
            let mut log_lines: Vec<&str> = Vec::new();

            for line in block.lines() {
                if let Some(caps) = ts_re.captures(line) {
                    timestamp = Some(caps[1].to_string());
                } else if let Some(caps) = theme_re.captures(line) {
                    theme = Some(caps[1].to_string());
                } else if let Some(caps) = source_re.captures(line) {
                    source = Some(caps[1].to_string());
                } else if !line.trim().is_empty() {
                    log_lines.push(line);
                }
            }

            if let Some(ts) = timestamp {
                if !log_lines.is_empty() {
                    entries.push(HotEntry {
                        timestamp: ts,
                        log: log_lines.join("\n").trim().to_string(),
                        theme,
                        source,
                    });
                }
            }
        }
    }

    entries.sort_by_key(|e| Reverse(e.timestamp.clone()));
    Ok(entries)
}
```

- [ ] **Step 2: Add `regex` dependency to `Cargo.toml`**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
regex = "1"
```

- [ ] **Step 3: Register the command in `main.rs`**

Update the `invoke_handler` in `src-tauri/src/main.rs`:

```rust
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
            vault::get_hot_entries,
        ])
```

- [ ] **Step 4: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/vault.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(desktop): add hot entries parsing command"
```

---

## Task 4: Implement vault.rs — warm themes and pending updates

**Files:**
- Modify: `src-tauri/src/vault.rs`
- Modify: `src-tauri/src/main.rs`

**Reference:** `packages/ui/server.ts:213-240` (warm themes), `packages/ui/server.ts:58-73` (pending updates), `packages/ui/server.ts:75-103` (approve/reject)

- [ ] **Step 1: Add a shared frontmatter parser to `vault.rs`**

Add this helper to `vault.rs` (below the existing helpers):

```rust
/// Splits a file into (frontmatter YAML string, body content).
/// Returns None if no frontmatter delimiters found.
fn parse_frontmatter(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    // Find the closing ---
    let after_first = &trimmed[3..].trim_start_matches(['\r', '\n']);
    let end = after_first.find("\n---")?;
    let fm = after_first[..end].to_string();
    let body = after_first[end + 4..].trim_start_matches(['\r', '\n']).to_string();
    Some((fm, body))
}
```

- [ ] **Step 2: Add warm themes command**

Append to `vault.rs`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmTheme {
    pub theme: String,
    pub content: String,
    pub last_updated: String,
}

#[tauri::command]
pub fn get_warm_themes(state: tauri::State<'_, AppState>) -> Result<Vec<WarmTheme>, String> {
    let warm_dir = state.warm_dir();
    let mut themes: Vec<WarmTheme> = Vec::new();

    let files = match fs::read_dir(&warm_dir) {
        Ok(f) => f,
        Err(_) => return Ok(themes),
    };

    for entry in files.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || path.extension().map_or(true, |e| e != "md") {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let theme_name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let mut last_updated = String::new();
        let content;

        if let Some((fm, body)) = parse_frontmatter(&raw) {
            // Extract lastUpdated from frontmatter
            for line in fm.lines() {
                let line = line.trim();
                if let Some(val) = line.strip_prefix("lastUpdated:") {
                    last_updated = val.trim().to_string();
                }
            }
            content = body.trim().to_string();
        } else {
            content = raw.trim().to_string();
        }

        themes.push(WarmTheme {
            theme: theme_name,
            content,
            last_updated,
        });
    }

    themes.sort_by(|a, b| b.last_updated.cmp(&a.last_updated));
    Ok(themes)
}
```

- [ ] **Step 3: Add pending updates commands**

Append to `vault.rs`:

```rust
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub id: String,
    pub theme: String,
    pub proposed_content: String,
    pub previous_content: Option<String>,
    pub entries: Vec<PendingEntry>,
    pub created_at: String,
    pub status: String,
}

#[derive(Serialize, serde::Deserialize)]
pub struct PendingEntry {
    pub timestamp: String,
    pub log: String,
}

#[tauri::command]
pub fn list_pending_updates(state: tauri::State<'_, AppState>) -> Result<Vec<PendingUpdate>, String> {
    let pending_dir = state.pending_dir();
    let mut updates: Vec<PendingUpdate> = Vec::new();

    let files = match fs::read_dir(&pending_dir) {
        Ok(f) => f,
        Err(_) => return Ok(updates),
    };

    for entry in files.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "json") {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let update: PendingUpdate = match serde_json::from_str(&raw) {
            Ok(u) => u,
            Err(_) => continue,
        };

        if update.status == "pending" {
            updates.push(update);
        }
    }

    updates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(updates)
}

#[tauri::command]
pub fn approve_update(
    state: tauri::State<'_, AppState>,
    id: String,
    edited_content: Option<String>,
) -> Result<(), String> {
    let pending_path = state.pending_dir().join(format!("{}.json", id));
    let raw = fs::read_to_string(&pending_path)
        .map_err(|e| format!("Failed to read pending update: {}", e))?;
    let update: PendingUpdate = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse pending update: {}", e))?;

    let final_content = edited_content.unwrap_or(update.proposed_content);
    let now = chrono::Utc::now().to_rfc3339();
    let warm_content = format!(
        "---\ntheme: {}\nlastUpdated: {}\n---\n\n{}\n",
        update.theme, now, final_content
    );

    fs::write(state.warm_dir().join(format!("{}.md", update.theme)), warm_content)
        .map_err(|e| format!("Failed to write warm theme: {}", e))?;

    fs::remove_file(&pending_path)
        .map_err(|e| format!("Failed to remove pending file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn reject_update(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let pending_path = state.pending_dir().join(format!("{}.json", id));
    fs::remove_file(&pending_path)
        .map_err(|e| format!("Failed to remove pending file: {}", e))?;
    Ok(())
}
```

- [ ] **Step 4: Register all new commands in `main.rs`**

Update the `invoke_handler`:

```rust
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
            vault::get_hot_entries,
            vault::get_warm_themes,
            vault::list_pending_updates,
            vault::approve_update,
            vault::reject_update,
        ])
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/vault.rs src-tauri/src/main.rs
git commit -m "feat(desktop): add warm themes and pending update commands"
```

---

## Task 5: Implement config.rs — LLM config read/write

**Files:**
- Create: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/main.rs`

**Reference:** `packages/ui/server.ts:120-170` and `packages/core/src/config.ts:8-15` for defaults.

- [ ] **Step 1: Create `src-tauri/src/config.rs`**

```rust
use std::fs;
use serde::{Deserialize, Serialize};
use crate::vault::AppState;

#[derive(Serialize)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
}

#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    themes: Vec<String>,
    #[serde(default)]
    llm: Option<LlmSection>,
}

#[derive(Deserialize)]
struct LlmSection {
    provider: Option<String>,
    model: Option<String>,
}

const DEFAULT_PROVIDER: &str = "anthropic";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";

#[tauri::command]
pub fn get_llm_config(state: tauri::State<'_, AppState>) -> Result<LlmConfig, String> {
    let config_path = state.config_path();
    let raw = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => {
            return Ok(LlmConfig {
                provider: DEFAULT_PROVIDER.to_string(),
                model: DEFAULT_MODEL.to_string(),
            });
        }
    };

    let config: ConfigFile = serde_yaml::from_str(&raw).unwrap_or(ConfigFile {
        themes: vec![],
        llm: None,
    });

    let llm = config.llm.unwrap_or(LlmSection {
        provider: None,
        model: None,
    });

    Ok(LlmConfig {
        provider: llm.provider.unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
        model: llm.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
    })
}

#[tauri::command]
pub fn save_llm_settings(
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let config_path = state.config_path();

    // Read existing config to preserve themes
    let mut themes: Vec<String> = vec![];
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_yaml::from_str::<ConfigFile>(&raw) {
            themes = config.themes;
        }
    }

    // Build YAML manually to match existing format
    let mut yaml = String::new();
    if !themes.is_empty() {
        yaml.push_str("themes:\n");
        for theme in &themes {
            yaml.push_str(&format!("  - {}\n", theme));
        }
    }
    yaml.push_str(&format!("llm:\n  provider: {}\n  model: {}\n", provider, model));

    fs::write(&config_path, &yaml)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    if let Some(key) = api_key {
        let env_var = match provider.as_str() {
            "anthropic" => "ANTHROPIC_API_KEY",
            "openai" => "OPENAI_API_KEY",
            "gemini" => "GEMINI_API_KEY",
            _ => "ANTHROPIC_API_KEY",
        };
        eprintln!(
            "[desktop] API key for {} received ({}...). Set {} env var for the dream pipeline.",
            provider,
            &key[..6.min(key.len())],
            env_var
        );
    }

    Ok(())
}
```

- [ ] **Step 2: Register config commands in `main.rs`**

Add `mod config;` at the top and update the handler:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;
mod config;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(vault::AppState::new())
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
            vault::get_hot_entries,
            vault::get_warm_themes,
            vault::list_pending_updates,
            vault::approve_update,
            vault::reject_update,
            config::get_llm_config,
            config::save_llm_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(desktop): add LLM config read/write commands"
```

---

## Task 6: Implement skills.rs — skill discovery and eligibility

**Files:**
- Create: `src-tauri/src/skills.rs`
- Modify: `src-tauri/src/main.rs`

**Reference:** `packages/ui/server.ts:242-326` and `packages/skills/src/index.ts` for the data model. Skills are discovered from `packages/skills/builtin/` and `~/OpenPulseAI/skills/`. Each skill is a directory containing a `SKILL.md` with YAML frontmatter.

- [ ] **Step 1: Create `src-tauri/src/skills.rs`**

```rust
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Deserialize, Serialize};
use crate::vault::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillData {
    pub name: String,
    pub description: String,
    pub schedule: Option<String>,
    pub lookback: String,
    pub requires: SkillRequires,
    pub eligible: bool,
    pub missing: Vec<String>,
    pub last_run_at: Option<String>,
    pub last_status: String,
    pub entries_collected: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub is_builtin: bool,
}

#[derive(Serialize)]
pub struct SkillRequires {
    pub bins: Vec<String>,
    pub env: Vec<String>,
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
    schedule: Option<String>,
    lookback: Option<String>,
    requires: Option<SkillRequiresFm>,
}

#[derive(Deserialize, Default)]
struct SkillRequiresFm {
    #[serde(default)]
    bins: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectorState {
    last_run_at: Option<String>,
    last_status: Option<String>,
    entries_collected: Option<usize>,
    last_error: Option<String>,
}

fn discover_skills_in_dir(dir: &Path, is_builtin: bool, vault_root: &Path) -> Vec<SkillData> {
    let mut skills = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };

    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.path().is_dir() {
            continue;
        }

        let skill_file = entry.path().join("SKILL.md");
        let raw = match fs::read_to_string(&skill_file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let fm = match parse_skill_frontmatter(&raw) {
            Some(f) => f,
            None => continue,
        };

        let name = match fm.name {
            Some(n) => n,
            None => continue,
        };
        let description = match fm.description {
            Some(d) => d,
            None => continue,
        };

        let requires_fm = fm.requires.unwrap_or_default();
        let mut missing: Vec<String> = Vec::new();
        let mut eligible = true;

        // Check bins
        for bin in &requires_fm.bins {
            let found = Command::new("which")
                .arg(bin)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !found {
                eligible = false;
                missing.push(format!("bin: {}", bin));
            }
        }

        // Check env vars
        for env_var in &requires_fm.env {
            if std::env::var(env_var).is_err() {
                eligible = false;
                missing.push(format!("env: {}", env_var));
            }
        }

        // Load collector state
        let state_path = vault_root
            .join("vault")
            .join("collector-state")
            .join(format!("{}.json", name));
        let collector = fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<CollectorState>(&raw).ok());

        skills.push(SkillData {
            name,
            description,
            schedule: fm.schedule,
            lookback: fm.lookback.unwrap_or_else(|| "24h".to_string()),
            requires: SkillRequires {
                bins: requires_fm.bins,
                env: requires_fm.env,
            },
            eligible,
            missing,
            last_run_at: collector.as_ref().and_then(|c| c.last_run_at.clone()),
            last_status: collector
                .as_ref()
                .and_then(|c| c.last_status.clone())
                .unwrap_or_else(|| "never".to_string()),
            entries_collected: collector
                .as_ref()
                .and_then(|c| c.entries_collected)
                .unwrap_or(0),
            last_error: collector.and_then(|c| c.last_error),
            is_builtin,
        });
    }

    skills
}

fn parse_skill_frontmatter(raw: &str) -> Option<SkillFrontmatter> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let after_first = trimmed[3..].trim_start_matches(['\r', '\n']);
    let end = after_first.find("\n---")?;
    let fm_str = &after_first[..end];
    serde_yaml::from_str(fm_str).ok()
}

#[tauri::command]
pub fn get_skills(state: tauri::State<'_, AppState>) -> Result<Vec<SkillData>, String> {
    // Builtin skills: relative to the app binary in dev, or bundled in production
    // In dev mode, use the workspace path
    let builtin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages")
        .join("skills")
        .join("builtin");

    let user_dir = state.vault_root.join("skills");

    let mut builtin_skills = discover_skills_in_dir(&builtin_dir, true, &state.vault_root);
    let user_skills = discover_skills_in_dir(&user_dir, false, &state.vault_root);

    // User skills override builtins with the same name
    for user_skill in user_skills {
        if let Some(pos) = builtin_skills.iter().position(|s| s.name == user_skill.name) {
            builtin_skills[pos] = user_skill;
        } else {
            builtin_skills.push(user_skill);
        }
    }

    Ok(builtin_skills)
}
```

- [ ] **Step 2: Register the command in `main.rs`**

Add `mod skills;` and update the handler:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;
mod config;
mod skills;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(vault::AppState::new())
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
            vault::get_hot_entries,
            vault::get_warm_themes,
            vault::list_pending_updates,
            vault::approve_update,
            vault::reject_update,
            config::get_llm_config,
            config::save_llm_settings,
            skills::get_skills,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/skills.rs src-tauri/src/main.rs
git commit -m "feat(desktop): add skill discovery and eligibility commands"
```

---

## Task 7: Implement sidecar.rs — dream pipeline and skill operations

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/main.rs`

**Reference:** `packages/ui/server.ts:106-118` (trigger dream), `packages/ui/server.ts:328-364` (skill install/remove/run). The SEA sidecars are spawned as child processes via Tauri's shell plugin.

- [ ] **Step 1: Create `src-tauri/src/sidecar.rs`**

```rust
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use crate::vault::AppState;

#[tauri::command]
pub async fn trigger_dream(app: tauri::AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("openpulse-dream")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .output()
        .await
        .map_err(|e| format!("Failed to run dream pipeline: {}", e))?;

    if output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(if stderr.is_empty() {
            "Dream pipeline completed.".to_string()
        } else {
            stderr.into_owned()
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Dream pipeline failed: {}",
            if stderr.is_empty() {
                "unknown error".to_string()
            } else {
                stderr.into_owned()
            }
        ))
    }
}

#[tauri::command]
pub async fn run_skill(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("openpulse-skills")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(["--run", &name])
        .output()
        .await
        .map_err(|e| format!("Failed to run skill: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(if stderr.is_empty() {
        "Skill completed.".to_string()
    } else {
        stderr.into_owned()
    })
}

#[tauri::command]
pub async fn install_skill(
    state: tauri::State<'_, AppState>,
    repo: String,
) -> Result<String, String> {
    // Skill install uses git clone into ~/OpenPulseAI/skills/<name>
    // Same approach as server.ts which runs `npx skillsadd <repo>`
    let skills_dir = state.vault_root.join("skills");
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let output = std::process::Command::new("git")
        .args(["clone", &repo])
        .current_dir(&skills_dir)
        .output()
        .map_err(|e| format!("Failed to run git clone: {}", e))?;

    if output.status.success() {
        Ok("Skill installed.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install skill: {}", stderr))
    }
}

#[tauri::command]
pub async fn remove_skill(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let skill_dir = state.vault_root.join("skills").join(&name);
    if skill_dir.is_dir() {
        std::fs::remove_dir_all(&skill_dir)
            .map_err(|e| format!("Failed to remove skill: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 2: Register sidecar commands in `main.rs`**

Final `main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;
mod config;
mod skills;
mod sidecar;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(vault::AppState::new())
        .invoke_handler(tauri::generate_handler![
            vault::get_vault_health,
            vault::get_vault_path,
            vault::get_hot_entries,
            vault::get_warm_themes,
            vault::list_pending_updates,
            vault::approve_update,
            vault::reject_update,
            config::get_llm_config,
            config::save_llm_settings,
            skills::get_skills,
            sidecar::trigger_dream,
            sidecar::run_skill,
            sidecar::install_skill,
            sidecar::remove_skill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI/src-tauri
cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/main.rs
git commit -m "feat(desktop): add sidecar commands for dream and skill operations"
```

---

## Task 8: Update tauri-bridge.ts — typed Tauri imports

**Files:**
- Modify: `packages/ui/src/lib/tauri-bridge.ts`
- Modify: `packages/ui/package.json`

- [ ] **Step 1: Add `@tauri-apps/api` dependency**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
pnpm --filter @openpulse/ui add -D @tauri-apps/api@^2
```

Expected: Package added to `packages/ui/package.json` devDependencies.

- [ ] **Step 2: Update `tauri-bridge.ts`**

Replace the first 46 lines of `packages/ui/src/lib/tauri-bridge.ts` (everything up to and including the `apiPost` function) with:

```typescript
import { invoke } from "@tauri-apps/api/core";

// Types matching the core package
export interface VaultHealth {
  hotCount: number;
  warmCount: number;
  pendingCount: number;
  vaultExists: boolean;
}

export interface PendingUpdate {
  id: string;
  theme: string;
  proposedContent: string;
  previousContent: string | null;
  entries: Array<{ timestamp: string; log: string }>;
  createdAt: string;
  status: string;
}

// Detect Tauri runtime
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Dev API server base URL
const API_BASE = "http://localhost:3001/api";

// --- Transport layer ---

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
```

The rest of the file (lines 48-152, the public API functions) stays exactly as-is.

- [ ] **Step 3: Verify the UI still builds**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds. The `@tauri-apps/api/core` import is already marked as external in `vite.config.ts`, so Vite skips it.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/tauri-bridge.ts packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(ui): switch tauri-bridge to typed @tauri-apps/api imports"
```

---

## Task 9: Add build scripts and SEA integration

**Files:**
- Modify: `package.json` (root)
- Create: `scripts/build-desktop.sh`

- [ ] **Step 1: Create `scripts/build-desktop.sh`**

```bash
#!/usr/bin/env bash
# scripts/build-desktop.sh — Build the Tauri desktop app with SEA sidecars
set -euo pipefail

echo "==> Building all TypeScript packages..."
pnpm build

echo "==> Building SEA sidecars..."
bash scripts/build-sea.sh dream
bash scripts/build-sea.sh skills

echo "==> Copying sidecars to src-tauri/sidecars/..."
mkdir -p src-tauri/sidecars

# Determine the target triple for Tauri sidecar naming
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Tauri expects sidecars named: <name>-<target-triple>
# Copy SEA binaries or fallback .cjs bundles
if [ -f "dist/dream" ]; then
  cp dist/dream "src-tauri/sidecars/openpulse-dream-${TRIPLE}"
elif [ -f "dist/dream.cjs" ]; then
  echo "WARNING: Using .cjs bundle (not a true SEA). Node.js required on PATH."
  cp dist/dream.cjs "src-tauri/sidecars/openpulse-dream-${TRIPLE}"
fi

if [ -f "dist/skills" ]; then
  cp dist/skills "src-tauri/sidecars/openpulse-skills-${TRIPLE}"
elif [ -f "dist/skills.cjs" ]; then
  echo "WARNING: Using .cjs bundle (not a true SEA). Node.js required on PATH."
  cp dist/skills.cjs "src-tauri/sidecars/openpulse-skills-${TRIPLE}"
fi

echo "==> Building Tauri app..."
cargo tauri build

echo "==> Done! Check src-tauri/target/release/bundle/ for the .app and .dmg"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/build-desktop.sh
```

- [ ] **Step 3: Add root package.json scripts**

Add these scripts to the root `package.json`:

```json
"dev:desktop": "cargo tauri dev",
"build:desktop": "bash scripts/build-desktop.sh",
"build:sea:skills": "bash scripts/build-sea.sh skills"
```

The `scripts` section should now be:

```json
"scripts": {
  "build": "pnpm -r build",
  "test": "vitest run",
  "test:watch": "vitest",
  "build:sea:mcp": "bash scripts/build-sea.sh mcp-server",
  "build:sea:dream": "bash scripts/build-sea.sh dream",
  "build:sea:skills": "bash scripts/build-sea.sh skills",
  "dev:desktop": "cargo tauri dev",
  "build:desktop": "bash scripts/build-desktop.sh"
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/build-desktop.sh package.json
git commit -m "feat(desktop): add build scripts and SEA sidecar integration"
```

---

## Task 10: End-to-end smoke test

**Files:** No new files — this is a verification task.

- [ ] **Step 1: Build the UI**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
pnpm build
```

Expected: All packages build successfully.

- [ ] **Step 2: Run all existing tests**

```bash
pnpm vitest run
```

Expected: All ~292 tests pass. No regressions.

- [ ] **Step 3: Compile the Rust backend**

```bash
cd src-tauri
cargo build
```

Expected: Compiles successfully. First build will take a few minutes to download and compile crates.

- [ ] **Step 4: Launch in dev mode**

```bash
cd /Users/maxillis/Documents/GitHub/OpenPulseAI
pnpm dev:desktop
```

Expected: Vite dev server starts on :1420, Tauri window opens showing the OpenPulse Control Center. The dashboard should load and show vault health data (assuming `~/OpenPulseAI/vault/` exists with data).

- [ ] **Step 5: Verify each page**

Manually click through:
1. **Dashboard** — should show hot/warm/pending counts
2. **Hot Log** — should list hot entries with timestamps
3. **Warm Themes** — should show curated theme summaries
4. **Review** — should show pending updates (if any)
5. **Skills** — should list discovered skills with eligibility status
6. **Settings** — should show current LLM provider and model

If any page fails, check the Tauri dev console (Cmd+Option+I) for errors — the `isTauri` flag should be `true` and commands should be hitting the Rust backend.

- [ ] **Step 6: Test a write operation**

If you have pending updates, approve one from the Review page. Verify the warm theme file is updated in `~/OpenPulseAI/vault/warm/`.

- [ ] **Step 7: Commit any fixes**

If smoke testing revealed issues, fix them and commit:

```bash
git add -A
git commit -m "fix(desktop): address smoke test issues"
```

If no fixes needed, skip this step.
