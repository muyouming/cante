//! Tauri `invoke` commands — thin wrappers over [`crate::daemon::Daemon`].
//!
//! Every argument name is snake_case, matching the keys the frontend sends and
//! the contract table. Each op-sending command returns `{ "ok": true }`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::State;

use crate::daemon::{Daemon, StartSessionArgs};

/// The spreadsheet helper's file name. On Windows the executable carries the
/// `.exe` suffix, and that is what both the app bundle and `PATH` contain.
const SHEET_BIN_NAME: &str = if cfg!(windows) { "cante-sheets.exe" } else { "cante-sheets" };

/// Shown to the user when no helper could be found. One plain-Chinese sentence.
const SHEET_UNAVAILABLE_WHY: &str = "这台电脑还没有表格读写工具。";

/// Whether this computer can read and write spreadsheets, and where the helper
/// lives. Serialized straight to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SheetCapability {
    pub available: bool,
    pub path: Option<String>,
    pub why: Option<String>,
}

/// Resolve `cante-sheets` without touching the real process environment, so the
/// lookup order can be unit-tested. Order is frozen (issue #75):
///
/// 1. `CANTE_SHEETS_BIN` — if set at all, use it as-is;
/// 2. next to the current executable;
/// 3. `../Resources/cante-sheets` next to the executable (macOS app bundle);
/// 4. `$HOME/.cante/bin/cante-sheets`;
/// 5. anywhere on `PATH`.
///
/// Nothing found → `available: false` with a plain-Chinese `why`.
pub fn resolve_sheet_bin(
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> SheetCapability {
    if let Some(value) = env_bin {
        let value = value.trim();
        if !value.is_empty() {
            return available(value);
        }
    }

    if let Some(dir) = exe_dir {
        if let Some(found) = existing(dir.join(SHEET_BIN_NAME)) {
            return available(&found);
        }
        if let Some(found) = existing(dir.join("..").join("Resources").join(SHEET_BIN_NAME)) {
            return available(&found);
        }
    }

    if let Some(home) = home {
        if let Some(found) = existing(home.join(".cante").join("bin").join(SHEET_BIN_NAME)) {
            return available(&found);
        }
    }

    if let Some(raw_path) = path_var {
        for dir in std::env::split_paths(raw_path) {
            if let Some(found) = existing(dir.join(SHEET_BIN_NAME)) {
                return available(&found);
            }
        }
    }

    SheetCapability { available: false, path: None, why: Some(SHEET_UNAVAILABLE_WHY.to_string()) }
}

fn existing(path: PathBuf) -> Option<String> {
    if path.is_file() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn available(path: &str) -> SheetCapability {
    SheetCapability { available: true, path: Some(path.to_string()), why: None }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Does this computer have the spreadsheet helper? The frontend turns this into
/// a line in the instruction envelope, or a neutral notice on the confirm page.
#[tauri::command]
pub fn sheet_capability() -> SheetCapability {
    let env_bin = std::env::var("CANTE_SHEETS_BIN").ok();
    let exe_dir =
        std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf));
    let home = home_dir();
    let path_var = std::env::var("PATH").ok();
    resolve_sheet_bin(env_bin.as_deref(), exe_dir.as_deref(), home.as_deref(), path_var.as_deref())
}

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
pub fn steer(state: State<'_, Daemon>, text: String) -> Result<Value, String> {
    state.steer(&text)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn shell_input(state: State<'_, Daemon>, command: String) -> Result<Value, String> {
    state.shell_input(&command)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn ambient_phrase(
    state: State<'_, Daemon>,
    draft: String,
    request_id: u64,
) -> Result<Value, String> {
    state.ambient_phrase(&draft, request_id)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn ambient_suggestion(
    state: State<'_, Daemon>,
    recent_user: String,
    recent_agent: String,
    request_id: u64,
) -> Result<Value, String> {
    state.ambient_suggestion(&recent_user, &recent_agent, request_id)?;
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

// ---------------------------------------------------------------------------
// 测试：能力探测的纯函数
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0);
            let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("cante-capability-{label}-{stamp}-{serial}"));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 在目录下造一个（空的）可执行文件，返回它的路径字符串。
    fn place(dir: &Path) -> String {
        fs::create_dir_all(dir).expect("create dir");
        let binary = dir.join(SHEET_BIN_NAME);
        fs::write(&binary, b"#!/bin/sh\n").expect("write stub");
        binary.to_string_lossy().into_owned()
    }

    #[test]
    fn env_var_wins_even_if_the_file_is_absent() {
        let cap = resolve_sheet_bin(Some("/custom/cante-sheets"), None, None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some("/custom/cante-sheets"));
        assert!(cap.why.is_none());
    }

    #[test]
    fn blank_env_var_is_ignored() {
        let cap = resolve_sheet_bin(Some("   "), None, None, None);
        assert!(!cap.available);
    }

    #[test]
    fn finds_the_binary_next_to_the_executable() {
        let dir = TempDir::new("exe");
        let expected = place(&dir.0);
        let cap = resolve_sheet_bin(None, Some(&dir.0), None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn falls_back_to_the_macos_resources_folder() {
        let dir = TempDir::new("resources");
        let exe_dir = dir.0.join("Contents").join("MacOS");
        fs::create_dir_all(&exe_dir).expect("create MacOS");
        let expected = place(&dir.0.join("Contents").join("Resources"));
        let cap = resolve_sheet_bin(None, Some(&exe_dir), None, None);
        assert!(cap.available);
        // 解析出来的是 `<exe>/../Resources/cante-sheets`，用规范路径比对。
        let got = std::fs::canonicalize(cap.path.as_deref().expect("path")).expect("canonical");
        let want = std::fs::canonicalize(&expected).expect("canonical");
        assert_eq!(got, want);
    }

    #[test]
    fn falls_back_to_the_home_directory() {
        let dir = TempDir::new("home");
        let expected = place(&dir.0.join(".cante").join("bin"));
        let cap = resolve_sheet_bin(None, None, Some(&dir.0), None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn falls_back_to_path() {
        let dir = TempDir::new("path");
        let expected = place(&dir.0);
        let path_var = dir.0.to_string_lossy().into_owned();
        let cap = resolve_sheet_bin(None, None, None, Some(&path_var));
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn nothing_found_says_so_in_chinese() {
        let cap = resolve_sheet_bin(None, None, None, Some("/definitely/not/here"));
        assert!(!cap.available);
        assert!(cap.path.is_none());
        let why = cap.why.expect("why");
        assert!(why.contains("表格"), "why should be Chinese: {why}");
        assert!(!why.contains("cante-sheets"));
    }

    #[test]
    fn executable_directory_beats_home_and_path() {
        let dir = TempDir::new("order");
        let expected = place(&dir.0);
        let home = place(&dir.0.join("home").join(".cante").join("bin"));
        let path_var = dir.0.join("on-path").to_string_lossy().into_owned();
        place(&dir.0.join("on-path"));
        let cap = resolve_sheet_bin(None, Some(&dir.0), Some(&dir.0.join("home")), Some(&path_var));
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
        assert_ne!(cap.path.as_deref(), Some(home.as_str()));
    }
}
