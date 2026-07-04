use std::path::PathBuf;

/// Shared app state: just the resolved vault root today. Used to be the home
/// of a large set of Tauri commands (`get_vault_health`, `approve_update`,
/// etc.) that read/wrote the vault filesystem directly from Rust — those are
/// gone now that the always-on server sidecar (see `server_sidecar.rs`) owns
/// all vault I/O and the webview talks to it over plain `fetch` (see
/// `packages/ui/src/lib/tauri-bridge.ts`). What's left is just the one path
/// `server_sidecar.rs` needs to spawn the sidecar with the right
/// `OPENPULSE_VAULT` env var and to locate `ui-token`.
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
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
