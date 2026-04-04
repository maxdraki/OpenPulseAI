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

        for env_var in &requires_fm.env {
            if std::env::var(env_var).is_err() {
                eligible = false;
                missing.push(format!("env: {}", env_var));
            }
        }

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
    let builtin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("packages")
        .join("skills")
        .join("builtin");

    let user_dir = state.vault_root.join("skills");

    let mut builtin_skills = discover_skills_in_dir(&builtin_dir, true, &state.vault_root);
    let user_skills = discover_skills_in_dir(&user_dir, false, &state.vault_root);

    for user_skill in user_skills {
        if let Some(pos) = builtin_skills.iter().position(|s| s.name == user_skill.name) {
            builtin_skills[pos] = user_skill;
        } else {
            builtin_skills.push(user_skill);
        }
    }

    Ok(builtin_skills)
}
