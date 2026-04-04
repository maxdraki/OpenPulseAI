use std::path::PathBuf;
use std::fs;
use std::sync::LazyLock;
use serde::Serialize;
use std::cmp::Reverse;

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

/// Splits a file into (frontmatter YAML string, body content).
/// Returns None if no frontmatter delimiters found.
fn parse_frontmatter(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return None;
    }
    let after_first = &trimmed[3..].trim_start_matches(['\r', '\n']);
    let end = after_first.find("\n---")?;
    let fm = after_first[..end].to_string();
    let body = after_first[end + 4..].trim_start_matches(['\r', '\n']).to_string();
    Some((fm, body))
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

    static DATE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\d{4}-\d{2}-\d{2}\.md$").unwrap());
    static TS_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)").unwrap());
    static THEME_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\*\*Theme:\*\*\s*(.+)").unwrap());
    static SOURCE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\*\*Source:\*\*\s*(.+)").unwrap());

    for entry in files.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !DATE_RE.is_match(&name_str) {
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
                if let Some(caps) = TS_RE.captures(line) {
                    timestamp = Some(caps[1].to_string());
                } else if let Some(caps) = THEME_RE.captures(line) {
                    theme = Some(caps[1].to_string());
                } else if let Some(caps) = SOURCE_RE.captures(line) {
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

fn validate_id(id: &str) -> Result<(), String> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Invalid id".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn approve_update(
    state: tauri::State<'_, AppState>,
    id: String,
    edited_content: Option<String>,
) -> Result<(), String> {
    validate_id(&id)?;
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
    validate_id(&id)?;
    let pending_path = state.pending_dir().join(format!("{}.json", id));
    fs::remove_file(&pending_path)
        .map_err(|e| format!("Failed to remove pending file: {}", e))?;
    Ok(())
}
