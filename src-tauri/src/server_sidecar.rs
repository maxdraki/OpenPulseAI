//! Supervises the always-on UI/API server sidecar (`openpulse-ui-server`,
//! built from `packages/ui/server.ts` by `scripts/build-sidecar-ui.sh`).
//!
//! Unlike `trigger_dream`/`run_skill` in the old (now-removed) `sidecar.rs`
//! module, which spawned one-shot sidecars via `.output()` and waited for
//! them to exit, this module spawns `openpulse-ui-server` ONCE, keeps it
//! running for the lifetime of the app, and restarts it if it dies
//! unexpectedly. The webview never talks to Rust for vault/skills/dream data
//! any more (see `packages/ui/src/lib/tauri-bridge.ts`) — it fetches
//! straight from this server's `/api/*` routes. The only Tauri command left
//! is `get_server_info`, which hands the webview the `{ port, token }` it
//! needs to build that base URL.
//!
//! ## Dev-mode double-spawn guard
//!
//! `tauri.conf.json`'s `beforeDevCommand` only starts `vite` (see
//! `packages/ui/package.json`'s `dev:ui` script) — it does NOT start
//! `server.ts`. Per this repo's documented dev flow (see CLAUDE.md), a
//! developer typically already has `npx tsx server.ts` running in a second
//! terminal. If `cargo tauri dev` unconditionally spawned its own copy, both
//! would bind a port and, worse, both would run their own `Orchestrator`
//! (double-scheduled collectors/dream runs). `probe_existing_server` checks
//! the discovery file the server writes (`<vaultRoot>/ui-server.json`) and
//! does a real HTTP request to the port it names; ANY response (even a 401)
//! proves a live server is there, so we adopt its port instead of spawning.
//! This isn't dev-only — the same check runs before every spawn, packaged
//! or not, since a stale discovery file is otherwise indistinguishable from
//! a live one without actually probing it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{watch, Notify};

use crate::vault::AppState;

const SIDECAR_NAME: &str = "openpulse-ui-server";
const READY_PREFIX: &str = "OPENPULSE_SERVER_READY port=";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const DEV_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
const TOKEN_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTART_ATTEMPTS: u32 = 3;

/// Managed Tauri state: the current port (published via a `watch` channel so
/// `get_server_info` can await readiness instead of polling) and a handle to
/// the live child process (so `shutdown` can signal it).
pub struct ServerSupervisor {
    port_tx: watch::Sender<Option<u16>>,
    port_rx: watch::Receiver<Option<u16>>,
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    /// Notified by `shutdown()` so a pending restart backoff sleep in
    /// `run_supervised` wakes up immediately instead of finishing its full
    /// delay and spawning a fresh sidecar that would outlive app exit. See
    /// the `tokio::select!` in `run_supervised`'s restart path.
    shutdown_notify: Notify,
}

impl ServerSupervisor {
    pub fn new() -> Self {
        let (port_tx, port_rx) = watch::channel(None);
        Self {
            port_tx,
            port_rx,
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            shutdown_notify: Notify::new(),
        }
    }
}

impl Default for ServerSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub port: u16,
    pub token: String,
}

/// The ONE remaining Tauri command. Returns the base URL port and bearer
/// token the webview needs to talk to the server directly over `fetch` (see
/// `tauri-bridge.ts`'s `resolveApiBase`). Awaits readiness (up to
/// `READY_TIMEOUT`) if the supervisor hasn't finished starting yet, and
/// retries reading the token file briefly (up to `TOKEN_WAIT_TIMEOUT`) since
/// the server creates it fractionally after it starts listening.
#[tauri::command]
pub async fn get_server_info(
    supervisor: tauri::State<'_, ServerSupervisor>,
    app_state: tauri::State<'_, AppState>,
) -> Result<ServerInfo, String> {
    let port = await_port(&supervisor).await?;
    let token = read_token_with_retry(&app_state.vault_root).await?;
    Ok(ServerInfo { port, token })
}

async fn await_port(supervisor: &ServerSupervisor) -> Result<u16, String> {
    if let Some(port) = *supervisor.port_rx.borrow() {
        return Ok(port);
    }
    let mut rx = supervisor.port_rx.clone();
    let wait = async {
        loop {
            if rx.changed().await.is_err() {
                return None;
            }
            if let Some(port) = *rx.borrow() {
                return Some(port);
            }
        }
    };
    match tokio::time::timeout(READY_TIMEOUT, wait).await {
        Ok(Some(port)) => Ok(port),
        Ok(None) => Err("Server supervisor stopped before the server became ready".to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s waiting for the local server to start",
            READY_TIMEOUT.as_secs()
        )),
    }
}

async fn read_token_with_retry(vault_root: &Path) -> Result<String, String> {
    let token_path = vault_root.join("ui-token");
    let deadline = tokio::time::Instant::now() + TOKEN_WAIT_TIMEOUT;
    loop {
        match tokio::fs::read_to_string(&token_path).await {
            Ok(raw) => return Ok(raw.trim().to_string()),
            Err(err) if tokio::time::Instant::now() < deadline => {
                let _ = err;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(err) => {
                return Err(format!(
                    "Failed to read {}: {err}",
                    token_path.display()
                ))
            }
        }
    }
}

/// Directory the running app's own executable lives in — where Tauri places
/// `externalBin` sidecars alongside the main binary, in both `cargo tauri
/// dev` and a packaged bundle. Passed to the child as `OPENPULSE_BIN_DIR` so
/// `server.ts`'s orchestrator callbacks can resolve the dream/skills/aigis-
/// rollup sidecar binaries instead of a `process.cwd()`-relative dev path
/// that doesn't exist once cwd is this directory (see server.ts's
/// `resolveBin` helper and its doc comment).
fn sidecar_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Same resolution the old `skills.rs`'s (now-removed) `get_skills` command
/// used: prefer Tauri's bundled resource dir (`bundle.resources` in
/// `tauri.conf.json` maps `packages/core/builtin-skills/**` there), falling
/// back to the workspace path for `cargo tauri dev` runs where resources
/// aren't installed next to a bundle. Passed to the child as
/// `OPENPULSE_BUILTIN_SKILLS_DIR` — server.ts's skills discovery
/// (`/api/skills`, the orchestrator's `getSkillNames`) needs this since it
/// can no longer rely on `process.cwd()` pointing at `packages/ui` either.
fn builtin_skills_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .resource_dir()
        .ok()
        .map(|r| r.join("builtin-skills"))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("packages")
                .join("core")
                .join("builtin-skills")
        })
}

/// Reads `<vaultRoot>/ui-server.json` (written by `startServer`'s
/// `writeDiscoveryFile`) and, if present, makes a real HTTP request to the
/// port it names. Returns `Some(port)` only if that request actually got a
/// response — a stale file left behind by a killed process must not cause us
/// to skip spawning a real server.
async fn probe_existing_server(vault_root: &Path) -> Option<u16> {
    let discovery_path = vault_root.join("ui-server.json");
    let raw = tokio::fs::read_to_string(&discovery_path).await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let port = json.get("port")?.as_u64()? as u16;

    let client = reqwest::Client::builder()
        .timeout(DEV_PROBE_TIMEOUT)
        .build()
        .ok()?;
    client
        .get(format!("http://127.0.0.1:{port}/api/vault-health"))
        .send()
        .await
        .ok()?;
    Some(port)
}

/// Called once from `main.rs`'s `.setup()` hook. Runs in the background
/// (`.setup()` itself returns immediately) — `get_server_info` is what
/// actually awaits readiness, lazily, on the webview's first API call.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let vault_root = app.state::<AppState>().vault_root.clone();

        if let Some(port) = probe_existing_server(&vault_root).await {
            eprintln!(
                "[server-sidecar] Found an already-running server on port {port} \
                 (discovery file + health probe) — not spawning our own."
            );
            let _ = app.state::<ServerSupervisor>().port_tx.send(Some(port));
            return;
        }

        run_supervised(app, vault_root, 0).await;
    });
}

/// Spawns the sidecar, watches its stdout/stderr for the readiness line
/// (publishing the port once seen), then keeps draining output until it
/// exits. On an unexpected exit (not requested via `shutdown`), restarts up
/// to `MAX_RESTART_ATTEMPTS` times with linear backoff.
fn run_supervised(
    app: AppHandle,
    vault_root: PathBuf,
    attempt: u32,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let supervisor = app.state::<ServerSupervisor>();
        let bin_dir = sidecar_dir();
        let skills_dir = builtin_skills_dir(&app);

        let mut command = match app.shell().sidecar(SIDECAR_NAME) {
            Ok(c) => c,
            Err(err) => {
                eprintln!("[server-sidecar] Failed to resolve sidecar '{SIDECAR_NAME}': {err}");
                return;
            }
        };

        command = command.env("OPENPULSE_VAULT", vault_root.to_string_lossy().to_string());
        command = command.env(
            "OPENPULSE_BUILTIN_SKILLS_DIR",
            skills_dir.to_string_lossy().to_string(),
        );
        if let Some(home) = std::env::var_os("HOME") {
            command = command.env("HOME", home);
        }
        if let Some(dir) = &bin_dir {
            command = command.env("OPENPULSE_BIN_DIR", dir.to_string_lossy().to_string());
            command = command.current_dir(dir);
        }

        let (mut rx, child) = match command.spawn() {
            Ok(pair) => pair,
            Err(err) => {
                eprintln!("[server-sidecar] Failed to spawn '{SIDECAR_NAME}': {err}");
                return;
            }
        };

        *supervisor.child.lock().unwrap() = Some(child);

        let mut ready = false;
        let wait_ready = async {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes);
                        print!("[openpulse-ui-server] {line}");
                        if let Some(rest) = line.trim().strip_prefix(READY_PREFIX) {
                            if let Ok(port) = rest.trim().parse::<u16>() {
                                let _ = supervisor.port_tx.send(Some(port));
                                ready = true;
                                break;
                            }
                        }
                    }
                    CommandEvent::Error(err) => {
                        eprintln!("[server-sidecar] Sidecar error: {err}");
                    }
                    CommandEvent::Terminated(payload) => {
                        eprintln!(
                            "[server-sidecar] Sidecar exited before becoming ready: {payload:?}"
                        );
                        break;
                    }
                    _ => {}
                }
            }
        };

        if tokio::time::timeout(READY_TIMEOUT, wait_ready).await.is_err() {
            eprintln!(
                "[server-sidecar] Timed out after {}s waiting for readiness.",
                READY_TIMEOUT.as_secs()
            );
        }

        if !ready {
            // Startup failed outright (crashed before printing the readiness
            // line, or the wait above timed out). Don't restart-loop here —
            // get_server_info's own timeout will surface a clear error to
            // the webview instead of silently retrying forever.
            *supervisor.child.lock().unwrap() = None;
            return;
        }

        // Keep draining output (and the process alive) until it exits.
        loop {
            match rx.recv().await {
                Some(CommandEvent::Stdout(bytes)) | Some(CommandEvent::Stderr(bytes)) => {
                    print!("[openpulse-ui-server] {}", String::from_utf8_lossy(&bytes));
                }
                Some(CommandEvent::Terminated(payload)) => {
                    eprintln!("[server-sidecar] Sidecar exited: {payload:?}");
                    break;
                }
                Some(_) => {}
                None => break,
            }
        }

        *supervisor.child.lock().unwrap() = None;
        let _ = supervisor.port_tx.send(None);

        if supervisor.shutting_down.load(Ordering::SeqCst) {
            return; // Intentional shutdown (app exit) — don't restart.
        }

        if attempt + 1 >= MAX_RESTART_ATTEMPTS {
            eprintln!(
                "[server-sidecar] Giving up after {MAX_RESTART_ATTEMPTS} restart attempts — \
                 the local server is unavailable until the app is restarted."
            );
            return;
        }

        let backoff = Duration::from_secs(2 * u64::from(attempt + 1));
        eprintln!(
            "[server-sidecar] Restarting in {backoff:?} (attempt {}/{MAX_RESTART_ATTEMPTS})...",
            attempt + 2
        );

        // Race the backoff sleep against a shutdown notification so app quit
        // during the sleep aborts the restart instead of letting a fresh
        // sidecar spawn after the sleep completes (which would outlive the
        // app — see this module's doc comment / the review that found this).
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = supervisor.shutdown_notify.notified() => {
                eprintln!("[server-sidecar] Shutdown requested during restart backoff — not restarting.");
                return;
            }
        }

        // Belt-and-suspenders re-check: `shutdown()` calls `notify_one()`,
        // which stores a permit if nothing is awaiting `notified()` yet, so
        // the select! above is race-free even if shutdown happens right as
        // this task starts sleeping. This second check just guards against
        // future refactors weakening that guarantee (e.g. switching to
        // `notify_waiters()`, which does NOT store a permit for latecomers).
        if supervisor.shutting_down.load(Ordering::SeqCst) {
            return;
        }

        run_supervised(app, vault_root, attempt + 1).await;
    })
}

/// Called from `main.rs` on `RunEvent::ExitRequested` (the tray's real Quit,
/// Cmd+Q, or app-menu Quit — see `tray.rs`'s doc comment on which paths those
/// are). Sends SIGTERM (not `CommandChild::kill()`, which is SIGKILL on Unix
/// — see the `shared_child` crate docs) so the server's own SIGTERM handler
/// (`server.ts`'s `cleanup()`) gets a chance to stop the orchestrator and
/// remove the discovery file. Window hide/show (tray "Open"/close-to-hide)
/// never calls this — only real app exit does.
pub fn shutdown(app: &AppHandle) {
    let supervisor = app.state::<ServerSupervisor>();
    supervisor.shutting_down.store(true, Ordering::SeqCst);

    // Wake a pending restart backoff sleep in `run_supervised` (see its
    // `tokio::select!`) so a quit during the sleep aborts the restart rather
    // than letting a fresh sidecar spawn after we've already returned here —
    // otherwise that spawn would outlive the app as an orphaned process.
    // Harmless no-op (permit stored for next `notified()`, or just unused)
    // when there's no child to kill / no restart pending.
    supervisor.shutdown_notify.notify_one();

    let Some(child) = supervisor.child.lock().unwrap().take() else {
        return;
    };
    let pid = child.pid();

    #[cfg(unix)]
    {
        // SAFETY: signaling a process we spawned ourselves, by its own pid.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        // No SIGTERM equivalent on Windows; best effort is a hard kill. The
        // server's cleanup (discovery file removal) is a nice-to-have there,
        // not correctness-critical (nothing reads a stale discovery file
        // without also probing it — see `probe_existing_server`).
        let _ = child.kill();
    }
}
