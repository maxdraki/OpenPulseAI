//! System tray icon + menu, and the close-to-hide window lifecycle.
//!
//! Goal: schedules (and, later, the always-on sidecar) keep running after the user closes the
//! main window. Closing the window hides it instead of exiting the process; the tray's "Open
//! OpenPulseAI" item (or left-clicking the tray icon, where the platform supports it) brings it
//! back. Only the tray's "Quit" item, or the OS-level Cmd+Q / app-menu Quit on macOS, actually
//! terminates the app.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, WindowEvent,
};

const OPEN_MENU_ID: &str = "open";
const QUIT_MENU_ID: &str = "quit";
const MAIN_WINDOW_LABEL: &str = "main";

/// Builds the tray icon and its menu, and wires up menu/tray-click handling.
///
/// Called once from the `.setup()` hook in `main.rs`.
///
/// Icon note: we reuse `app.default_window_icon()` (the regular, full-color `icons/icon.png`,
/// decoded once at build time by tauri's codegen) rather than a dedicated monochrome template
/// asset. `icons/` has no monochrome/template variant today, so `icon_as_template` is left off —
/// enabling it against a colorful icon would render as a solid black/white silhouette on macOS,
/// which looks worse than the plain icon. Follow-up: add `icons/tray-template.png` (monochrome,
/// alpha-only) and call `.icon_as_template(true)` for the native macOS adaptive look.
pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, OPEN_MENU_ID, "Open OpenPulseAI", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("OpenPulse")
        // The menu already provides an explicit "Open" action; don't also pop it on every
        // left-click so a plain left-click can restore the window instead (see on_tray_icon_event).
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .build(app)?;

    Ok(())
}

/// Global menu-event handler, registered via `Builder::on_menu_event`.
pub fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        OPEN_MENU_ID => show_main_window(app),
        QUIT_MENU_ID => app.exit(0),
        _ => {}
    }
}

/// Global tray-icon-event handler, registered via `Builder::on_tray_icon_event`.
///
/// Left-click shows the window (macOS/Windows). Where the platform doesn't deliver tray click
/// events at all (Linux), the menu remains the only way to reach "Open"/"Quit" — see the
/// `TrayIconEvent` docs for the per-platform caveat.
pub fn handle_tray_icon_event(app: &AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show_main_window(app);
    }
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Global window-event handler, registered via `Builder::on_window_event`.
///
/// Intercepts `CloseRequested` on the main window: prevents the actual close and hides it
/// instead, so the app keeps running in the tray. Other windows (there are none today) would
/// close normally. This does not affect real shutdown paths (tray Quit / Cmd+Q / app-menu Quit),
/// which call `AppHandle::exit` directly and never emit `CloseRequested`.
pub fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();

        #[cfg(target_os = "macos")]
        {
            let _ = window
                .app_handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
}
