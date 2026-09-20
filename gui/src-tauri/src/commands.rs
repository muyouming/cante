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
        // 直接与可执行文件同目录 / macOS 的 ../Resources（Tauri 的资源目录）。
        if let Some(found) = existing(dir.join(bin_name)) {
            return available(&found);
        }
        if let Some(found) = existing(dir.join("..").join("Resources").join(bin_name)) {
            return available(&found);
        }
        // 以及"资源按原目录结构打包"后的位置：tauri 的 resources 用数组写 glob 时，
        // 文件会落到 $RESOURCE/target/release/<名字>。Windows 上产物的名字带 .exe，
        // 所以这里不能只找无扩展名的那一个（这正是 #112 的另一半）。
        let bundled = ["target", "release"];
        let nested = bundled.iter().fold(dir.to_path_buf(), |acc, part| acc.join(part));
        if let Some(found) = existing(nested.join(bin_name)) {
            return available(&found);
        }
        let resources_nested = ["..", "Resources", "target", "release"]
            .iter()
            .fold(dir.to_path_buf(), |acc, part| acc.join(part));
        if let Some(found) = existing(resources_nested.join(bin_name)) {
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

// ---------------------------------------------------------------------------
// 守护进程探测（#103）
//
// 上游 `cante` / `ante` 只有 macOS 与 Linux 构建，Windows 上没有原生守护进程；
// 而界面用 `CANTE_BIN`（否则 PATH 里的 `cante`）去拉起它。结果是 Windows 用户装完
// 安装包后界面能开、任务一个也跑不了，界面却什么都不说。这个探测就是让界面先问
// 一句「这台电脑上到底有没有那个组件」，然后把答案如实说出来。
// ---------------------------------------------------------------------------

/// 找不到守护进程时给用户看的一句话。前端会把它直接放到「检查电脑」那一屏。
const DAEMON_UNAVAILABLE_WHY: &str = "这台电脑上还没有装好 Cante 需要的那个组件。";

/// 桥在、但动手的那个组件不在时给用户看的一句话（#150）。
///
/// 与上面那句的区别很重要：那种情况是**这个软件本身少了一块**，她自己那一步不是
/// 「找技术同事装组件」，而是**把安装包再运行一次**——随包发的东西丢了，重装就有。
const ASSISTANT_UNAVAILABLE_WHY: &str =
    "这台电脑上缺一个动手的组件，可以重新安装一次 Cante。";

/// 真正干活的组件在不在、在哪里、不在时怎么跟用户说。序列化后直接给前端；
/// `why` 和 `searched` 都是给用户（或她的技术同事）看的中文事实。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DaemonCapability {
    pub available: bool,
    pub path: Option<String>,
    pub why: Option<String>,
    /// 探测时实际看过哪些位置；可用时为空，不可用时用来给「复制详情」凑事实。
    pub searched: Vec<String>,
    /// 出路是不是「把这个软件重新装一次」（#150）。缺的是随包发的那一块时才是 true；
    /// 缺上游守护进程（要技术同事装）时是 false。前端据此换那句话里的动作。
    pub reinstall: bool,
}

/// 这台电脑上能不能找到真正干活的组件。
///
/// 解析顺序就是**拉起进程时走的那一条**（只有一份实现：[`crate::program`]）：
///
/// 1. `CANTE_BIN` —— 一旦给了就是它，**不再往下找**（运行时不回退，这里也不回退，
///    否则会报成可用而骗了用户）；
/// 2. 应用自己旁边（`cante` 优先，然后我们随包发的 `cante-bridge`）；
/// 3. `$HOME/.cante/bin/`；
/// 4. `PATH` 里的每个目录。
///
/// 找到的如果是**我们随包发的桥**，还要再看一层「动手的那个组件」在不在（#150）：
/// 桥在、它起不来的话，界面说「就绪」就是骗她。
///
/// 环境、常见目录、PATH 全部由参数传入，所以 `cargo test` 能逐条复盘。
pub fn resolve_daemon_bin(
    env_bin: Option<&str>,
    assistant_env: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> DaemonCapability {
    let daemon = crate::program::locate_daemon(env_bin, exe_dir, home, path_var);
    let Some(found) = daemon.path() else {
        return daemon_unavailable(daemon.searched().to_vec(), false);
    };

    if crate::program::is_bundled_bridge(found) {
        let assistant = crate::program::locate_assistant(assistant_env, exe_dir, home, path_var);
        if assistant.path().is_none() {
            return daemon_unavailable(assistant.searched().to_vec(), true);
        }
    }

    daemon_available(found)
}

fn daemon_available(path: &str) -> DaemonCapability {
    DaemonCapability {
        available: true,
        path: Some(path.to_string()),
        why: None,
        searched: Vec::new(),
        reinstall: false,
    }
}

/// 缺组件时的事实。`reinstall` 说的是出路：缺随包发的那一块（#150）时她自己重装
/// 一次就行；缺上游守护进程（#103）时得找技术同事。
fn daemon_unavailable(searched: Vec<String>, reinstall: bool) -> DaemonCapability {
    DaemonCapability {
        available: false,
        path: None,
        why: Some(
            if reinstall { ASSISTANT_UNAVAILABLE_WHY } else { DAEMON_UNAVAILABLE_WHY }.to_string(),
        ),
        searched,
        reinstall,
    }
}

/// 这台电脑有没有真正干活的组件？向导的「检查电脑」和出错界面都靠它说实话。
#[tauri::command]
pub fn daemon_capability() -> DaemonCapability {
    let env_bin = std::env::var("CANTE_BIN").ok();
    let assistant_env = std::env::var("PI_BIN").ok();
    let exe_dir = crate::program::current_exe_dir();
    let home = crate::program::home_dir();
    let path_var = std::env::var("PATH").ok();
    resolve_daemon_bin(
        env_bin.as_deref(),
        assistant_env.as_deref(),
        exe_dir.as_deref(),
        home.as_deref(),
        path_var.as_deref(),
    )
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
        // 工具的错误是「中文在前、原文在后」两段（壳用 `sheets::error_stderr` 拼）。
        // 端出去之前先把原文切掉：库/系统的原话（多半是英文）只进日志，给来帮忙的
        // 技术同事看 —— 绝不跟她看的那句话拼在一起（产品律 3 的「复制详情」）。
        let stderr = String::from_utf8_lossy(&output.stderr);
        let (visible, detail) = split_sheet_stderr(&stderr);
        if let Some(detail) = detail {
            eprintln!("cante read_result_sheet: {detail}");
        }
        return Err(if visible.is_empty() { SHEET_READ_FAILED_WHY.to_string() } else { visible });
    }

    // `cante-sheets read` 输出的是标准 CSV：逗号、引号、格子里的换行都已经转义，
    // 所以这里按 CSV 解析回去，格子的内容不会被拆错。
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(crate::sheets::csv_to_rows(&stdout))
}

/// 把 `cante-sheets` 的 stderr 拆成「给她看的那句」和「给技术同事看的原文」。
///
/// 壳打印的格式是：她看的中文那句，然后 `DETAIL_MARKER` 一行，再是库/系统的原话
/// （见 `sheets::error_stderr`）。这里只把标记**之前**那段交给她；标记之后那段
/// （可能是英文）交给调用方送进日志 —— 关键是她看的那句里永远不会有英文。
///
/// 没有标记时（#279 之后所有普通错误都是这样）整段就是她看的那句，原文为空：
/// 不凭空造详情，也不丢任何一个字。
fn split_sheet_stderr(stderr: &str) -> (String, Option<String>) {
    let text = stderr.trim();
    match text.split_once(crate::sheets::DETAIL_MARKER) {
        Some((visible, detail)) => {
            let detail = detail.trim();
            (visible.trim().to_string(), (!detail.is_empty()).then(|| detail.to_string()))
        }
        None => (text.to_string(), None),
    }
}

/// 读表的阻塞任务自己没能跑完（`spawn_blocking` 的 `JoinError`：任务 panic 了，
/// 或者运行时正在关停）时的处理。
///
/// 它跟 [`read_sheet_rows`] 不是一条路：那条路是她能看懂的故障（文件坏了、工具不在），
/// 这一条是**我们自己的代码**出了岔子——`JoinError` 的原文（`task … panicked`）是
/// 英文，绝不能端到她面前。所以她看中文那句兜底，原文只进日志给技术同事，和
/// `read_sheet_rows` 的分层一致（产品律 3）。`pub` 是为了让集成测试盯住这个契约。
pub fn read_task_failed(error: &dyn std::fmt::Display) -> String {
    eprintln!("cante read_result_sheet: 读表的任务没能跑完：{error}");
    SHEET_READ_FAILED_WHY.to_string()
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
    .map_err(|error| read_task_failed(&error))??;
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

    /// 守护进程在测试里的两个写法（真名字在 `crate::program` 的候选表里）。
    const DAEMON_BIN_NAME: &str = "cante";
    const DAEMON_BIN_NAME_EXE: &str = "cante.exe";

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

    /// #112：打包后的资源会保留原目录结构（`$RESOURCE/target/release/<名字>`），
    /// 而 Windows 上的名字带 `.exe`。解析器必须能找到这两种位置——真机验收时正是这里
    /// 让"我们做出来的工具在 Windows 上等于没有"（配置没打包 + 找不到）。
    #[test]
    fn finds_a_tool_bundled_under_target_release() {
        let dir = TempDir::new("bundled");
        let expected = place_named(&dir.0.join("target").join("release"), SHEET_BIN_NAME);
        let found = resolve_tool_bin(SHEET_BIN_NAME, None, Some(&dir.0), None, None, "缺");
        assert!(found.available, "应当找到 {expected}");
        assert_eq!(found.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn finds_a_tool_bundled_under_the_macos_resources_tree() {
        let dir = TempDir::new("bundled-macos");
        let expected = place_named(
            &dir.0.join("..").join("Resources").join("target").join("release"),
            SHEET_BIN_NAME,
        );
        let found = resolve_tool_bin(SHEET_BIN_NAME, None, Some(&dir.0), None, None, "缺");
        assert!(found.available, "应当找到 {expected}");
        assert_eq!(found.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn a_tool_of_the_other_platforms_name_does_not_count() {
        // 名字是平台相关的（`cfg!(windows)` 决定带不带 .exe）。放一个"另一种平台"的
        // 文件名进去，必须**不算**找到——否则我们会对外宣称有工具却调不起来。
        //
        // 注意：每个测试要用自己的根目录。`../Resources/...` 会跳出当前目录，
        // 如果几个测试共用父目录，一个测试放的文件会被另一个测试找到（写过一次，红了）。
        let outer = TempDir::new("wrong-name");
        let dir = outer.0.join("isolated");
        fs::create_dir_all(&dir).expect("create dir");
        let other = if cfg!(windows) { "cante-sheets" } else { "cante-sheets.exe" };
        place_named(&dir.join("target").join("release"), other);
        let found = resolve_tool_bin(SHEET_BIN_NAME, None, Some(&dir), None, None, "缺");
        assert!(!found.available, "不该把 {other} 当成 {SHEET_BIN_NAME}");
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

    // -----------------------------------------------------------------------
    // 守护进程探测（#103）。
    //
    // 四类必须分别有答案：CANTE_BIN 给了且存在 / 给了但不存在 / 没给但 PATH 里
    // 有 / 都没有；而且「都找不到」时要能用中文说清缺的是什么、找过哪里。
    // -----------------------------------------------------------------------

    #[test]
    fn daemon_env_bin_found_is_available() {
        let dir = TempDir::new("daemon-env");
        let expected = place_named(&dir.0, DAEMON_BIN_NAME);
        let cap = resolve_daemon_bin(Some(&expected), None, None, None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
        assert!(cap.why.is_none());
        assert!(cap.searched.is_empty(), "找到了就不用再说找过哪里");
    }

    #[test]
    fn daemon_env_bin_with_arguments_is_resolved() {
        // CANTE_BIN 是一段命令，不是单纯的路径：Windows 上会写成 `wsl.exe -e …`。
        let dir = TempDir::new("daemon-args");
        let program = place_named(&dir.0, DAEMON_BIN_NAME_EXE);
        let spec = format!("\"{program}\" -e /home/wang/ante serve");
        let cap = resolve_daemon_bin(Some(&spec), None, None, None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(program.as_str()));
    }

    #[test]
    fn daemon_env_bin_missing_is_unavailable() {
        let cap = resolve_daemon_bin(Some("/definitely/not/here/cante"), None, None, None, None);
        assert!(!cap.available);
        assert!(cap.path.is_none());
        let why = cap.why.expect("why");
        assert!(why.contains("组件"), "要说缺的是组件：{why}");
        assert!(why.contains("电脑"), "该是给人看的中文：{why}");
        assert!(!why.contains("cante"), "不该把程序名端给用户：{why}");
        assert_eq!(cap.searched, vec!["/definitely/not/here/cante".to_string()]);
    }

    #[test]
    fn daemon_env_bin_does_not_fall_back_to_path() {
        // 运行时不回退（CANTE_BIN 一旦给了就是它），探测也不能报成可用。
        let dir = TempDir::new("daemon-no-fallback");
        place_named(&dir.0, DAEMON_BIN_NAME);
        let path_var = dir.0.to_string_lossy().into_owned();
        let cap =
            resolve_daemon_bin(Some("/definitely/not/here/cante"), None, None, None, Some(&path_var));
        assert!(!cap.available);
    }

    #[test]
    fn daemon_found_next_to_the_executable() {
        let dir = TempDir::new("daemon-exe");
        let expected = place_named(&dir.0, DAEMON_BIN_NAME);
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn daemon_windows_name_is_found_too() {
        // Windows 上只有 cante.exe；这段在任何平台上都跑得起来。
        let dir = TempDir::new("daemon-exe-win");
        let expected = place_named(&dir.0, DAEMON_BIN_NAME_EXE);
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn daemon_found_on_path() {
        let dir = TempDir::new("daemon-path");
        let expected = place_named(&dir.0, DAEMON_BIN_NAME);
        let path_var = dir.0.to_string_lossy().into_owned();
        let cap = resolve_daemon_bin(None, None, None, None, Some(&path_var));
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn daemon_found_in_the_home_directory() {
        let dir = TempDir::new("daemon-home");
        let expected =
            place_named(&dir.0.join("personal").join(".cante").join("bin"), DAEMON_BIN_NAME);
        let cap = resolve_daemon_bin(None, None, None, Some(&dir.0.join("personal")), None);
        assert!(cap.available);
        assert_eq!(cap.path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn daemon_nothing_found_says_so_in_chinese_and_lists_where() {
        let dir = TempDir::new("daemon-none");
        let path_var = dir.0.to_string_lossy().into_owned();
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), Some(&dir.0), Some(&path_var));
        assert!(!cap.available);
        assert!(cap.path.is_none());
        let why = cap.why.expect("why");
        assert!(why.contains("组件"), "why should name the component: {why}");
        assert!(why.contains("电脑"), "why should be Chinese: {why}");
        assert!(!why.contains("cante"), "不该把程序名端给用户：{why}");
        // 找过哪里是可核对的事实：程序旁边、个人文件夹、系统登记的文件夹。
        assert!(cap.searched.iter().any(|item| item.contains(".cante")), "{:?}", cap.searched);
        assert!(
            cap.searched.iter().any(|item| item.contains("系统")),
            "{}\n{why}",
            format!("{:?}", cap.searched)
        );
    }

    #[test]
    fn a_bundled_bridge_without_the_working_component_asks_for_a_reinstall() {
        // #150：应用旁边只有随包发的桥、没有动手的组件 —— 界面不能说「就绪」，
        // 也不能叫她去「找技术同事装组件」：重装一次这个软件就有了。
        let dir = TempDir::new("bridge-only");
        place_named(&dir.0, "cante-bridge.exe");
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(!cap.available);
        assert!(cap.reinstall, "出路是重新装一次：{:?}", cap);
        let why = cap.why.expect("why");
        assert!(why.contains("重新安装"), "要说清下一步：{why}");
        assert!(why.contains("组件"), "要说清缺的是什么：{why}");
        assert!(!why.contains("pi"), "不该把程序名端给用户：{why}");
        assert!(!why.contains("路径"), "黑名单词不能进用户文案：{why}");
        assert!(cap.searched.iter().any(|item| item.ends_with("pi")), "{:?}", cap.searched);
    }

    #[test]
    fn a_bundled_bridge_with_the_working_component_beside_it_is_ready() {
        let dir = TempDir::new("bridge-and-pi");
        place_named(&dir.0, "cante-bridge.exe");
        place_named(&dir.0, "pi.exe");
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(cap.available, "{:?}", cap);
        assert!(!cap.reinstall);
    }

    #[test]
    fn the_bundled_runtime_plus_entry_script_counts_as_the_working_component() {
        // 随包发的形态：`pi\bun.exe` + `pi\cli.js`（#150 定下的那条约定）。
        let dir = TempDir::new("bridge-and-bun");
        place_named(&dir.0, "cante-bridge.exe");
        place_named(&dir.0.join("pi"), "bun.exe");
        place_named(&dir.0.join("pi").join("dist").join("bundle"), "cli.js");
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(cap.available, "{:?}", cap);
    }

    #[test]
    fn hiding_the_bundled_assistant_flips_the_answer_to_not_ready() {
        // 真机复现（#177）：同一个安装目录，先把随包的那组（`pi\bun.exe` +
        // `pi\dist\bundle\cli.js`）放好，探测说「在」；把它挪走之后，探测必须变成
        // 「不在」——「就绪」不允许还有第二种说法（那正是绿勾看 `--version` 时的事）。
        let dir = TempDir::new("hide-pi");
        place_named(&dir.0, "cante-bridge.exe");
        place_named(&dir.0.join("pi"), "bun.exe");
        place_named(&dir.0.join("pi").join("dist").join("bundle"), "cli.js");
        let before = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(before.available, "{before:?}");

        fs::remove_dir_all(dir.0.join("pi")).expect("把 pi 目录挪走");
        let after = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(!after.available, "动手的组件被挪走了就不能再说就绪：{after:?}");
        assert!(after.reinstall, "缺的是随包发的那一块，出路是重装：{after:?}");
    }

    #[test]
    fn an_upstream_daemon_needs_no_component_of_ours() {
        // 上游的 `cante`（或 WSL 里的 `ante`）不是我们的桥，它不需要 pi。
        let dir = TempDir::new("upstream-only");
        place_named(&dir.0, "cante.exe");
        let cap = resolve_daemon_bin(None, None, Some(&dir.0), None, None);
        assert!(cap.available, "{:?}", cap);
        assert!(!cap.reinstall);
    }

    #[test]
    fn daemon_capability_command_shape_is_consistent() {
        // 命令壳读的是真实进程环境，所以这里只钉住内部一致性，不钉具体值。
        let cap = daemon_capability();
        assert_eq!(cap.available, cap.path.is_some());
        assert_eq!(cap.why.is_none(), cap.available);
        if cap.available {
            assert!(cap.searched.is_empty());
        }
    }
}
