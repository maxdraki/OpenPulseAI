# Desktop (Tauri) manual verification checklist

The tray/close-to-hide lifecycle (task 19) and the persistent sidecar +
bridge collapse (task 20) both require a real display server and real
sidecar binaries, so none of this is exercised by CI or by an agent. Walk
through this checklist end-to-end on macOS (or the relevant OS) after any
change touching `src-tauri/**` or `packages/ui/src/lib/tauri-bridge.ts`
before considering the desktop app release-ready. Steps are ordered so each
one builds on the app state left by the previous one.

## 0. Build

1. From the repo root: `pnpm build:desktop` (this runs `pnpm build`, builds
   the `openpulse-dream` / `openpulse-skills` / `openpulse-aigis-rollup` SEA
   sidecars via `scripts/build-sea.sh`, builds the `openpulse-ui-server`
   sidecar, copies everything into `src-tauri/sidecars/` with the
   target-triple suffix, then runs `cargo tauri build`).
   - If you need to iterate faster without a full bundle, `cargo tauri dev`
     from `src-tauri` after `pnpm build` also works for most of the steps
     below (skip step 9's packaged-only parts).

## 1. Cold start

2. Launch the packaged `.app` (or `cargo tauri dev`). Confirm the window
   loads the Dashboard with real data, not stuck on a loading spinner — this
   proves `get_server_info` resolved successfully and the webview's `fetch`
   calls are reaching the sidecar (CORS + token both correct).
3. `ps aux | grep openpulse-ui-server` — confirm exactly one instance is
   running, owned by the `.app`'s process tree.

## 2. Tray show/hide

4. Confirm a tray icon appears in the menu bar (macOS: top-right) showing
   the OpenPulse logo.
5. Click the tray icon — confirm a menu appears with "Open OpenPulseAI", a
   separator, and "Quit".
6. With the window focused, use the tray menu's "Open OpenPulseAI" item (or
   click the tray icon directly) while the window is already open — confirm
   it shows/focuses the existing window rather than misbehaving.

## 3. Close-to-hide + orchestrator/sidecar survival

7. With the main window focused, click the window's close button. Confirm:
   - The window disappears.
   - The app process is still running (Activity Monitor / `ps aux | grep
     openpulse-desktop`).
   - The Dock icon disappears (macOS `Accessory` mode).
   - `openpulse-ui-server` is STILL running (`ps aux`) — this is the whole
     point of the persistent-sidecar change: schedules used to stop when the
     window closed.
   - A scheduled collector still fires while the window is hidden (check
     `vault/logs/*.jsonl` for activity, or wait for a scheduled run).
8. Reopen: tray → "Open OpenPulseAI" (or left-click the tray icon). Confirm
   the window reappears, regains focus, the Dock icon reappears, and it's
   still talking to the SAME server instance (no new `openpulse-ui-server`
   process spawned — `ps aux` count is still 1, and any earlier
   `get_server_info` cache/state isn't lost).

## 4. Skills / dream runs in packaged mode

9. Skills page → run a builtin skill (e.g. Folder Watcher) manually. Confirm
   it completes without an `import.meta`/`fileURLToPath` error and without
   an ENOENT on `builtin-skills` (proves `OPENPULSE_BUILTIN_SKILLS_DIR`
   resolution works in a packaged build).
10. Dashboard → "Trigger Dream Now" (or equivalent). Confirm it actually
    runs (proves `resolveBin`'s `OPENPULSE_BIN_DIR` path found
    `openpulse-dream` rather than silently falling through to a
    `node <path-that-doesn't-exist>` failure).
11. Aigis rollup (if configured): trigger it from the Schedule page. Confirm
    it runs via the `openpulse-aigis-rollup` sidecar.

## 5. Search degradation notice

12. Themes page → search for something. Confirm the "Semantic search is
    unavailable in this build — showing keyword matches only" notice appears
    (expected in a packaged/SEA build, since `@huggingface/transformers` is
    excluded) and that results still come back (FTS-only).

## 6. Unexpected-kill restart

13. `kill -9` the `openpulse-ui-server` process manually while the app is
    running. Confirm the app detects the exit and respawns it within a few
    seconds (up to 3 attempts, linear backoff) — the webview should recover
    on its next API call.

## 7. Quit (no orphaned processes)

14. Tray → "Quit" (or Cmd+Q, or the app menu's "Quit OpenPulse" item —
    exercise at least two of these three paths across runs, since they're
    different code paths). Confirm BOTH the `.app` AND `openpulse-ui-server`
    processes exit:
    - `pgrep -f openpulse-ui-server` returns empty.
    - `ps aux | grep openpulse-desktop` shows no remaining process.
    - A `vault/logs/*.jsonl` line from the server's SIGTERM handler
      ("Received SIGTERM, shutting down...") confirms the graceful path (not
      a hard kill) actually ran.
15. Repeat step 14 via Cmd+Q specifically (a real quit must terminate the
    process, not just hide the window — proving `CloseRequested`
    interception from step 7 doesn't leak into the app-level quit path).

## 8. Dev-mode no-double-spawn

16. Run `npx tsx server.ts` manually in `packages/ui`, then separately
    launch `cargo tauri dev`. Confirm the Rust logs show "Found an
    already-running server... not spawning our own" and that only one
    `server.ts` process (the manual one) exists — no duplicate orchestrator
    runs.

## Known gaps / follow-ups

- No monochrome ("template") tray icon asset yet — the tray shows the
  full-color app icon rather than an adaptive macOS template icon.
- `rebuild-meta.js` / `lint-cli.js` / `compact-cli.js` /
  `schema-evolve-cli.js` don't have bundled sidecar binaries yet and fall
  back to a dev-relative path that doesn't exist in a packaged build.
- The `resolveApiBase` cache (webview side) only clears on a *lookup*
  failure, not when an already-cached port goes stale — an in-flight
  request to a just-restarted server on a new port will fail once before a
  fresh `get_server_info` call is triggered.
