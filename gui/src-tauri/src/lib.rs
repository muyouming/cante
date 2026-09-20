// Bootstrap for the Cante desktop shell. Workstream A owns everything below the
// `TODO(A)` markers; this file must keep `run()` as the entry point.
pub mod admin_config;
pub mod bridge;
pub mod commands;
pub mod daemon;
pub mod files;
pub mod pdf;
pub mod program;
pub mod protocol;
pub mod sheets;

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Emitter as _, Manager as _};

/// Bridges the daemon's event sink to Tauri's global event bus.
struct TauriEmitter {
    app: tauri::AppHandle,
}

impl daemon::Emitter for TauriEmitter {
    fn event(&self, event: &Value) {
        let _ = self.app.emit("cante://event", event.clone());
    }

    fn state(&self, state: &Value) {
        let _ = self.app.emit("cante://state", state.clone());
    }

    fn log(&self, stream: &str, line: &str) {
        let _ = self.app.emit("cante://log", json!({ "stream": stream, "line": line }));
    }

    fn exit(&self, code: Option<i32>) {
        let _ = self.app.emit("cante://exit", json!({ "code": code }));
    }
}

/// One step of bringing an already-open window back to the front.
///
/// There is deliberately no `Create` variant: a second double-click must never
/// produce a second window. `tests/single_instance.rs` pins the order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowActivation {
    /// A window parked in the taskbar has to come back before focus means anything.
    Unminimize,
    Show,
    SetFocus,
}

/// The ordered actions `surface_existing_window` applies to the chosen window.
pub const ACTIVATE_EXISTING_WINDOW: [WindowActivation; 3] = [
    WindowActivation::Unminimize,
    WindowActivation::Show,
    WindowActivation::SetFocus,
];

/// The window a second launch must bring to the front.
///
/// `tauri.conf.json` declares no label, so Tauri names the app's only window
/// `main`; prefer it and otherwise fall back to the first open window. Pure, so
/// `tests/single_instance.rs` can pin the choice without a running app.
///
/// Returning `None` (no window at all) is not licence to open one: the caller
/// only ever shows a window that already exists.
pub fn window_to_surface<'a>(labels: &[&'a str]) -> Option<&'a str> {
    match labels.iter().find(|label| **label == "main") {
        Some(label) => Some(*label),
        None => labels.first().copied(),
    }
}

/// Restore, show and focus the window that is already open. Returns `false`
/// when the app has no window (it still never creates one).
fn surface_existing_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let windows = app.webview_windows();
    let labels: Vec<&str> = windows.keys().map(String::as_str).collect();
    let Some(label) = window_to_surface(&labels) else {
        return false;
    };
    let Some(window) = windows.get(label) else {
        return false;
    };
    for step in ACTIVATE_EXISTING_WINDOW {
        let _ = match step {
            WindowActivation::Unminimize => window.unminimize(),
            WindowActivation::Show => window.show(),
            WindowActivation::SetFocus => window.set_focus(),
        };
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second double-click must surface this window, not start a twin.
        // Two instances share one `file-safety/` store and each spawns its own
        // daemon, so they clobber each other's run records and can undo each
        // other's files (see gui/docs/SINGLE-INSTANCE.md). Tauri runs a plugin's
        // setup hook in `Builder::build` -> `initialize_plugins`, before the
        // window is created and before the app's own `.setup` (which manages the
        // `Daemon`). Registering it first therefore makes it the earliest gate:
        // the second process exits before a window or a `Daemon` exists.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            surface_existing_window(app);
        }))
        // Remember window geometry between runs. Rust-side only, so no JS
        // permission is involved.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Native pickers plus "open / show in folder" for simple mode. The
        // commands live in `files.rs`, so the webview imports no JS plugin.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let emitter: Arc<dyn daemon::Emitter> =
                Arc::new(TauriEmitter { app: app.handle().clone() });
            app.manage(daemon::Daemon::new(emitter));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::admin_config,
            commands::events_since,
            commands::start_session,
            commands::update_session,
            commands::send_input,
            commands::steer,
            commands::shell_input,
            commands::ambient_phrase,
            commands::ambient_suggestion,
            commands::approve,
            commands::interrupt,
            commands::compact,
            commands::context_report,
            commands::slash,
            commands::goal,
            commands::catalog,
            commands::sheet_capability,
            commands::tool_capabilities,
            commands::daemon_capability,
            commands::read_result_sheet,
            commands::set_cwd,
            commands::shutdown,
            files::pick_files,
            files::pick_folder,
            files::open_path,
            files::reveal_path,
            files::begin_run,
            files::snapshot_paths,
            files::file_facts,
            files::save_run,
            files::run_log,
            files::undo_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cante");
}
