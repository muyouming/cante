//! 读结果表的集成测试：起一个真实的 `cante-sheets` 进程，把写好的 .xlsx 读回来。
//!
//! `src/commands.rs` 里的单测盯的是「没有工具时返回错误、不是空表」；这里盯的是
//! 整条链路真的通：用库写一个结果文件，再让 `read_sheet_rows` 按产品真实的方式
//! （`cante-sheets read`）把它变成一行行文字，内容和写进去的一致。
//!
//! 用 `CARGO_BIN_EXE_cante-sheets` 拿二进制位置：cargo 会为集成测试编译并把这个
//! 环境变量设好，所以测的是本 worktree 刚编出来的那一个，不是机器上碰巧装的。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::commands::{read_sheet_rows, read_task_failed};
use cante_gui_lib::sheets::write_xlsx;

/// 本 worktree 刚编出来的 cante-sheets。
const SHEETS_BIN: &str = env!("CARGO_BIN_EXE_cante-sheets");

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|delta| delta.as_nanos()).unwrap_or(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("cante-result-sheet-{label}-{stamp}-{serial}"));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn path_str(path: &PathBuf) -> &str {
    path.to_str().expect("临时目录路径应当是 UTF-8")
}

#[test]
fn reads_a_result_table_back_through_the_real_helper() {
    let dir = TempDir::new("round-trip");
    let path = dir.join("销售汇总.xlsx");
    let rows = vec![
        vec!["姓名".to_string(), "金额".to_string(), "编号".to_string()],
        vec!["张三".to_string(), "1200".to_string(), "00123".to_string()],
        vec!["李四".to_string(), "800.5".to_string(), "00007".to_string()],
    ];
    write_xlsx(&path, &rows, "销售").expect("write xlsx");

    let read_back =
        read_sheet_rows(SHEETS_BIN, path_str(&path), None).expect("已经写好的表必须读得回来");
    assert_eq!(read_back, rows);
    // 前导 0 和整数不能走样——她最在意的就是这两个。
    assert_eq!(read_back[1][2], "00123");
    assert!(!read_back[1][1].contains('.'));
}

#[test]
fn a_named_sheet_can_be_read_by_name() {
    let dir = TempDir::new("named");
    let path = dir.join("明细.xlsx");
    let rows = vec![vec!["部门".to_string()], vec!["行政部".to_string()]];
    write_xlsx(&path, &rows, "明细表").expect("write xlsx");

    let read_back =
        read_sheet_rows(SHEETS_BIN, path_str(&path), Some("明细表")).expect("按表名要读得回来");
    assert_eq!(read_back, rows);

    // 表名对不上：是错误（并且是中文），不是空表。
    let error = read_sheet_rows(SHEETS_BIN, path_str(&path), Some("没有这张"))
        .expect_err("表名不存在必须报错");
    assert!(error.contains("没有叫"), "要说是哪张表不在：{error}");
}

#[test]
fn a_missing_file_is_an_error_not_an_empty_table() {
    let dir = TempDir::new("missing");
    let missing = dir.join("没有这个文件.xlsx");
    let error = read_sheet_rows(SHEETS_BIN, path_str(&missing), None)
        .expect_err("文件不在必须报错，不能返回空表");
    assert!(error.contains("文件不存在"), "应是中文说明：{error}");
    assert!(!error.contains("路径"), "黑名单词不能进用户文案：{error}");
}

#[test]
fn an_unreadable_file_is_an_error_not_an_empty_table() {
    let dir = TempDir::new("broken");
    let broken = dir.join("坏文件.xlsx");
    fs::write(&broken, b"this is definitely not a zip").expect("write broken file");
    let error = read_sheet_rows(SHEETS_BIN, path_str(&broken), None)
        .expect_err("坏文件必须报错，不能返回空表");
    assert!(!error.is_empty());
    assert!(error.contains("坏") || error.contains("读"), "应是中文说明：{error}");
}

#[test]
fn a_missing_tool_is_an_error_not_an_empty_table() {
    let dir = TempDir::new("no-tool");
    let path = dir.join("无所谓.xlsx");
    write_xlsx(&path, &[vec!["一".to_string()]], "Sheet1").expect("write xlsx");
    let error = read_sheet_rows("/definitely/not/here/cante-sheets", path_str(&path), None)
        .expect_err("工具不在必须报错，不能返回空表");
    assert!(!error.contains("路径"), "黑名单词不能进用户文案：{error}");
    assert!(!error.is_empty());
}

/// 读图阻塞任务自己 panic / 运行时关停时，交给她看的只能是中文兜底那句；
/// `JoinError` 的英文原文（`task … panicked`）只进日志。
///
/// 这一条和 `read_sheet_rows` 不是一条路：那条是她能看懂的故障，这一条是我们自己的
/// 代码出了岔子——更容易被当成“内部错误、无所谓”，所以用测试把它钉住。
#[test]
fn a_failed_read_task_shows_her_chinese_only() {
    // 真 JoinError 的 Display 长这样（这里用手写字符串替身，不真去制造 panic）。
    let raw = "task 42 panicked at src/commands.rs:380:9: index out of bounds";
    let shown = read_task_failed(&raw);
    assert!(shown.contains("没能读出来"), "她应该看到中文的兜底说明：{shown}");
    for leak in ["panicked", "task", "index", "bounds", raw] {
        assert!(!shown.to_lowercase().contains(&leak.to_lowercase()), "漏了英文 {leak:?}：{shown}");
    }
}
