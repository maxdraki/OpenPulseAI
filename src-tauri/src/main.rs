#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
