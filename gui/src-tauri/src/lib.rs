// Bootstrap for the Cante desktop shell. Workstream A owns everything below the
// `TODO(A)` markers; this file must keep `run()` as the entry point.
mod daemon;
mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            daemon::health,
            daemon::events_since,
            daemon::start_session,
            daemon::update_session,
            daemon::send_input,
            daemon::approve,
            daemon::interrupt,
            daemon::compact,
            daemon::context_report,
            daemon::slash,
            daemon::goal,
            daemon::catalog,
            daemon::set_cwd,
            daemon::shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cante");
}
