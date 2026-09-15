//! Tauri `invoke` commands — thin wrappers over [`crate::daemon::Daemon`].
//!
//! Every argument name is snake_case, matching the keys the frontend sends and
//! the contract table. Each op-sending command returns `{ "ok": true }`.

use serde_json::{json, Value};
use tauri::State;

use crate::daemon::{Daemon, StartSessionArgs};

#[tauri::command]
pub fn health(state: State<'_, Daemon>) -> Result<Value, String> {
    Ok(state.health())
}

#[tauri::command]
pub fn events_since(state: State<'_, Daemon>, cursor: u64) -> Result<Value, String> {
    Ok(state.events_since(cursor))
}

#[tauri::command(rename_all = "snake_case")]
pub fn start_session(
    state: State<'_, Daemon>,
    model: Option<String>,
    provider: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    cwd: Option<String>,
    resume_session_id: Option<String>,
) -> Result<Value, String> {
    state.start_session(StartSessionArgs {
        model,
        provider,
        effort,
        permission_mode,
        cwd,
        resume_session_id,
    })?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_session(
    state: State<'_, Daemon>,
    model: Option<Value>,
    permission_mode: Option<String>,
    title: Option<String>,
) -> Result<Value, String> {
    state.update_session(model, permission_mode, title)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn send_input(state: State<'_, Daemon>, text: String, mode: String) -> Result<Value, String> {
    state.send_input(&text, &mode)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn approve(
    state: State<'_, Daemon>,
    turn_id: String,
    responses: Vec<Value>,
) -> Result<Value, String> {
    state.approve(&turn_id, responses)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn interrupt(state: State<'_, Daemon>) -> Result<Value, String> {
    state.interrupt()?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn compact(state: State<'_, Daemon>, instructions: Option<String>) -> Result<Value, String> {
    state.compact(instructions)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn context_report(state: State<'_, Daemon>) -> Result<Value, String> {
    state.context_report()?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn slash(state: State<'_, Daemon>, name: String, args: String) -> Result<Value, String> {
    state.slash(&name, &args)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn goal(
    state: State<'_, Daemon>,
    command: String,
    condition: Option<String>,
) -> Result<Value, String> {
    state.goal(&command, condition)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn catalog(state: State<'_, Daemon>) -> Result<Value, String> {
    state.catalog()
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_cwd(state: State<'_, Daemon>, cwd: String) -> Result<Value, String> {
    state.set_cwd(&cwd)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn shutdown(state: State<'_, Daemon>) -> Result<Value, String> {
    state.shutdown()?;
    Ok(json!({ "ok": true }))
}
