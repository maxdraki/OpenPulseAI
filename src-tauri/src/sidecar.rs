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
