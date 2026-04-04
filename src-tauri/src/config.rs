use std::fs;
use serde::{Deserialize, Serialize};
use crate::vault::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
    #[serde(default)]
    themes: Vec<String>,
    #[serde(default)]
    llm: Option<LlmSection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmSection {
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
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
                base_url: None,
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
        base_url: None,
    });

    Ok(LlmConfig {
        provider: llm.provider.unwrap_or_else(|| DEFAULT_PROVIDER.to_string()),
        model: llm.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        base_url: llm.base_url,
    })
}

#[tauri::command]
pub fn save_llm_settings(
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    let config_path = state.config_path();

    let mut themes: Vec<String> = vec![];
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_yaml::from_str::<ConfigFile>(&raw) {
            themes = config.themes;
        }
    }

    let mut yaml = String::new();
    if !themes.is_empty() {
        yaml.push_str("themes:\n");
        for theme in &themes {
            yaml.push_str(&format!("  - {}\n", theme));
        }
    }
    yaml.push_str(&format!("llm:\n  provider: {}\n  model: {}\n", provider, model));
    if let Some(url) = &base_url {
        yaml.push_str(&format!("  baseUrl: {}\n", url));
    }

    fs::write(&config_path, &yaml)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    if let Some(key) = api_key {
        let env_var = match provider.as_str() {
            "anthropic" => "ANTHROPIC_API_KEY",
            "openai" => "OPENAI_API_KEY",
            "gemini" => "GEMINI_API_KEY",
            _ => "",
        };
        if !env_var.is_empty() {
            eprintln!(
                "[desktop] API key for {} received ({}...). Set {} env var for the dream pipeline.",
                provider,
                &key[..6.min(key.len())],
                env_var
            );
        }
    }

    Ok(())
}
