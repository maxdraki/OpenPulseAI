#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server_sidecar;
mod tray;
mod vault;

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(vault::AppState::new())
        .manage(server_sidecar::ServerSupervisor::new())
        .invoke_handler(tauri::generate_handler![server_sidecar::get_server_info])
        .on_window_event(tray::handle_window_event)
        .on_menu_event(tray::handle_menu_event)
        .on_tray_icon_event(tray::handle_tray_icon_event)
        .setup(|app| {
            tray::setup_tray(app)?;
            server_sidecar::init(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // The tray's real Quit / Cmd+Q / app-menu Quit — see tray.rs's doc
        // comment on why close-to-hide (WindowEvent::CloseRequested) never
        // reaches this. Everything else (window hide/show) must NOT touch
        // the sidecar.
        if let tauri::RunEvent::ExitRequested { .. } = event {
            server_sidecar::shutdown(app_handle);
        }
    });
}
