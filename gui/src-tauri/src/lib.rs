// Bootstrap for the Cante desktop shell. Workstream A owns everything below the
// `TODO(A)` markers; this file must keep `run()` as the entry point.
pub mod admin_config;
pub mod commands;
pub mod daemon;
pub mod files;
pub mod pdf;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
