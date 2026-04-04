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
