//! Tauri `invoke` commands — thin wrappers over [`crate::daemon::Daemon`].
//!
//! Every argument name is snake_case, matching the keys the frontend sends and
//! the contract table. Each op-sending command returns `{ "ok": true }`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tauri::State;

use crate::daemon::{Daemon, StartSessionArgs};

/// The helper binaries' file names. On Windows the executables carry the
/// `.exe` suffix, and that is what both the app bundle and `PATH` contain.
const SHEET_BIN_NAME: &str = if cfg!(windows) { "cante-sheets.exe" } else { "cante-sheets" };
const PDF_BIN_NAME: &str = if cfg!(windows) { "cante-pdf.exe" } else { "cante-pdf" };

/// Shown to the user when no helper could be found. One plain-Chinese sentence
/// per tool; the frontend puts these straight on screen.
const SHEET_UNAVAILABLE_WHY: &str = "这台电脑还没有表格读写工具。";
const PDF_UNAVAILABLE_WHY: &str = "这台电脑还没有处理 PDF 的工具。";

/// 表格工具在、但这次没读出内容时的兜底说明（工具自己一般会给出更具体的中文）。
const SHEET_READ_FAILED_WHY: &str = "这个表格没能读出来。";

/// Whether this computer can run one helper, and where that helper lives.
/// Serialized straight to the frontend; `why` is Chinese meant for the user.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ToolCapability {
    pub available: bool,
    pub path: Option<String>,
    pub why: Option<String>,
}

/// Kept so the older `sheet_capability` command and its callers keep working.
pub type SheetCapability = ToolCapability;

/// What this computer can and cannot do, one entry per helper. The frontend
/// probes this once at startup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ToolCapabilities {
    pub sheets: ToolCapability,
    pub pdf: ToolCapability,
}

/// Resolve one helper without touching the real process environment, so the
/// lookup order can be unit-tested. Both tools share this logic; only the file
/// name, the environment variable and the Chinese `why` differ. Order is frozen
/// (issues #50, #75):
///
/// 1. the tool's environment variable — if set at all, use it as-is;
/// 2. next to the current executable;
/// 3. `../Resources/<name>` next to the executable (macOS app bundle);
/// 4. `$HOME/.cante/bin/<name>`;
/// 5. anywhere on `PATH`.
///
/// Nothing found → `available: false` with a plain-Chinese `why`.
pub fn resolve_tool_bin(
    bin_name: &str,
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
    why: &str,
) -> ToolCapability {
    if let Some(value) = env_bin {
        let value = value.trim();
        if !value.is_empty() {
            return available(value);
        }
    }

    if let Some(dir) = exe_dir {
        if let Some(found) = existing(dir.join(bin_name)) {
            return available(&found);
        }
        if let Some(found) = existing(dir.join("..").join("Resources").join(bin_name)) {
            return available(&found);
        }
    }

    if let Some(home) = home {
        if let Some(found) = existing(home.join(".cante").join("bin").join(bin_name)) {
            return available(&found);
        }
    }

    if let Some(raw_path) = path_var {
        for dir in std::env::split_paths(raw_path) {
            if let Some(found) = existing(dir.join(bin_name)) {
                return available(&found);
            }
        }
    }

    ToolCapability { available: false, path: None, why: Some(why.to_string()) }
}

/// Resolve `cante-sheets` — the spreadsheet helper (#75).
pub fn resolve_sheet_bin(
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> ToolCapability {
    resolve_tool_bin(SHEET_BIN_NAME, env_bin, exe_dir, home, path_var, SHEET_UNAVAILABLE_WHY)
}

/// Resolve `cante-pdf` — the PDF helper (#50).
pub fn resolve_pdf_bin(
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> ToolCapability {
    resolve_tool_bin(PDF_BIN_NAME, env_bin, exe_dir, home, path_var, PDF_UNAVAILABLE_WHY)
}

fn existing(path: PathBuf) -> Option<String> {
    if path.is_file() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn available(path: &str) -> ToolCapability {
    ToolCapability { available: true, path: Some(path.to_string()), why: None }
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
pub fn sheet_capability() -> ToolCapability {
    let env_bin = std::env::var("CANTE_SHEETS_BIN").ok();
    let exe_dir =
        std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf));
    let home = home_dir();
    let path_var = std::env::var("PATH").ok();
    resolve_sheet_bin(env_bin.as_deref(), exe_dir.as_deref(), home.as_deref(), path_var.as_deref())
}

/// What can this computer do (#50): read/write spreadsheets and handle PDFs.
/// One probe for the whole family, so the frontend never asks tool by tool.
#[tauri::command]
pub fn tool_capabilities() -> ToolCapabilities {
    let sheet_env = std::env::var("CANTE_SHEETS_BIN").ok();
    let pdf_env = std::env::var("CANTE_PDF_BIN").ok();
    let exe_dir =
        std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf));
    let home = home_dir();
    let path_var = std::env::var("PATH").ok();

    ToolCapabilities {
        sheets: resolve_sheet_bin(
            sheet_env.as_deref(),
            exe_dir.as_deref(),
            home.as_deref(),
            path_var.as_deref(),
        ),
        pdf: resolve_pdf_bin(
            pdf_env.as_deref(),
            exe_dir.as_deref(),
            home.as_deref(),
            path_var.as_deref(),
        ),
    }
}

/// 读回一个结果表的内容，走的是应用自带的 `cante-sheets read`。
///
/// `tool` 是前端从 `sheet_capability` / `tool_capabilities` 拿到的工具位置（和
/// 探测用的是同一个），`path` 是结果文件，`sheet` 是可选的表名。
///
/// 失败时**绝不返回空表**：空表和「这张表本来就是空的」长得一模一样，而界面必须
/// 能分清「读不出来」和「没有内容可贴」。所以没有工具、工具跑不起来、退出码非 0，
/// 一律返回一句中文错误。
///
/// 纯函数：工具位置和文件位置都由参数传入，`cargo test` 可以拿真实的 `cante-sheets`
/// 和真实的 .xlsx 直接跑。
pub fn read_sheet_rows(
    tool: &str,
    path: &str,
    sheet: Option<&str>,
) -> Result<Vec<Vec<String>>, String> {
    let tool = tool.trim();
    if tool.is_empty() {
        return Err(SHEET_UNAVAILABLE_WHY.to_string());
    }

    let mut command = Command::new(tool);
    command.arg("read").arg(path);
    if let Some(name) = sheet.map(str::trim).filter(|name| !name.is_empty()) {
        command.arg("--sheet").arg(name);
    }

    // 工具不在（被删了、路径过时了）时，把操作系统的话换成用户看得懂的一句。
    let output = command.output().map_err(|_| SHEET_UNAVAILABLE_WHY.to_string())?;
    if !output.status.success() {
        // cante-sheets 的错误都是中文，直接端给用户；真的没有说明时才兜底。
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            SHEET_READ_FAILED_WHY.to_string()
        } else {
            message.to_string()
        });
    }

    // `cante-sheets read` 输出的是标准 CSV：逗号、引号、格子里的换行都已经转义，
    // 所以这里按 CSV 解析回去，格子的内容不会被拆错。
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(crate::sheets::csv_to_rows(&stdout))
}

/// 界面上的「复制成微信能贴的文字」用它把结果表读出来。
///
/// 读文件要走子进程，放到阻塞线程池里做，别卡住界面。
#[tauri::command(rename_all = "snake_case")]
pub async fn read_result_sheet(
    tool: String,
    path: String,
    sheet: Option<String>,
) -> Result<Value, String> {
    let rows = tauri::async_runtime::spawn_blocking(move || {
        read_sheet_rows(&tool, &path, sheet.as_deref())
    })
    .await
    .map_err(|error| format!("读取表格时出了点问题：{error}"))??;
    Ok(json!({ "rows": rows }))
}

/// #58 — 这台电脑有没有被技术同事统一设过（企业预置配置）。
///
/// 读 `~/.cante/admin.json`（或 `CANTE_ADMIN_CONFIG` 指向的文件）。文件不存在、
/// 空的、坏了，一律返回 `present: false`，不让应用起不来；原因只进日志。
#[tauri::command]
pub fn admin_config() -> crate::admin_config::AdminConfig {
    crate::admin_config::load()
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
        place_named(dir, SHEET_BIN_NAME)
    }

    /// 同上，但可以指定工具名字（表格 / PDF 共用）。
    fn place_named(dir: &Path, name: &str) -> String {
        fs::create_dir_all(dir).expect("create dir");
        let binary = dir.join(name);
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

    // -----------------------------------------------------------------------
    // PDF 工具（#50）—— 和表格共用同一套解析顺序，只换文件名和文案。
    // -----------------------------------------------------------------------

    #[test]
    fn pdf_env_var_wins_even_if_the_file_is_absent() {
        let cap = resolve_pdf_bin(Some("/custom/cante-pdf"), None, None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some("/custom/cante-pdf"));
        assert!(cap.why.is_none());
    }

    #[test]
    fn pdf_found_next_to_the_executable() {
        let dir = TempDir::new("pdf-exe");
        let expected = place_named(&dir.0, PDF_BIN_NAME);
        let cap = resolve_pdf_bin(None, Some(&dir.0), None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn pdf_falls_back_to_home_and_path() {
        let dir = TempDir::new("pdf-home");
        let home_bin =
            place_named(&dir.0.join("personal").join(".cante").join("bin"), PDF_BIN_NAME);
        let cap = resolve_pdf_bin(None, None, Some(&dir.0.join("personal")), None);
        assert_eq!(cap.path.as_deref(), Some(home_bin.as_str()));

        let path_dir = dir.0.join("on-path");
        let path_bin = place_named(&path_dir, PDF_BIN_NAME);
        let path_var = path_dir.to_string_lossy().into_owned();
        let cap = resolve_pdf_bin(None, None, None, Some(&path_var));
        assert_eq!(cap.path.as_deref(), Some(path_bin.as_str()));
    }

    #[test]
    fn pdf_not_found_says_so_in_chinese() {
        let cap = resolve_pdf_bin(None, None, None, Some("/definitely/not/here"));
        assert!(!cap.available);
        assert!(cap.path.is_none());
        let why = cap.why.expect("why");
        assert!(why.contains("PDF"), "why should name PDF: {why}");
        assert!(why.contains("这台电脑"), "why should be Chinese: {why}");
        assert!(!why.contains("cante-pdf"));
    }

    #[test]
    fn each_tool_is_resolved_independently() {
        let dir = TempDir::new("both");
        // 只有表格工具时：表格命中，PDF 没命中，两边各说各的。
        let sheets = place_named(&dir.0, SHEET_BIN_NAME);
        assert_eq!(
            resolve_sheet_bin(None, Some(&dir.0), None, None).path.as_deref(),
            Some(sheets.as_str())
        );
        let pdf_cap = resolve_pdf_bin(None, Some(&dir.0), None, None);
        assert!(!pdf_cap.available);
        assert!(pdf_cap.why.as_deref().expect("why").contains("PDF"));

        // 再把 PDF 工具放进去：两个都命中，指向各自的文件。
        let pdf = place_named(&dir.0, PDF_BIN_NAME);
        assert_eq!(
            resolve_pdf_bin(None, Some(&dir.0), None, None).path.as_deref(),
            Some(pdf.as_str())
        );
    }

    #[test]
    fn a_blank_pdf_env_var_is_ignored() {
        let cap = resolve_pdf_bin(Some("   "), None, None, Some("/definitely/not/here"));
        assert!(!cap.available);
    }

    // -----------------------------------------------------------------------
    // 读结果表：失败必须说人话，绝不假装「表是空的」。
    // -----------------------------------------------------------------------

    #[test]
    fn no_tool_is_an_error_not_an_empty_table() {
        let error = read_sheet_rows("", "/tmp/结果.xlsx", None).expect_err("没有工具必须报错");
        assert!(error.contains("表格"), "应是中文说明：{error}");
        assert!(!error.contains("cante-sheets"), "不该把工具名端给用户：{error}");
        assert!(!error.contains("路径"), "黑名单词不能进用户文案：{error}");
    }

    #[test]
    fn a_tool_that_cannot_start_is_an_error() {
        let error = read_sheet_rows("/definitely/not/here/cante-sheets", "/tmp/结果.xlsx", None)
            .expect_err("工具跑不起来必须报错");
        assert!(!error.is_empty());
        assert!(!error.contains("路径"), "黑名单词不能进用户文案：{error}");
    }
}
