//! 表格读写的集成测试：只用库 API 走一遍"写 xlsx → 读回"，并确认 `describe`
//! 能报出表名。
//!
//! 放在 `tests/` 而不是 `src/sheets.rs` 里，是为了证明这套能力对 crate 外面也是
//! 可用的——`cante-sheets` 命令行的壳和 Tauri 命令都依赖同一个公开接口。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::sheets::{describe, read_sheet, write_xlsx, SheetError};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|delta| delta.as_nanos()).unwrap_or(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("cante-sheets-it-{label}-{stamp}-{serial}"));
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

#[test]
fn write_then_read_through_the_library_api() {
    let dir = TempDir::new("write-read");
    let path = dir.join("销售汇总.xlsx");

    let rows = vec![
        vec!["月份".to_string(), "金额".to_string(), "编号".to_string()],
        vec!["一月".to_string(), "1200".to_string(), "00123".to_string()],
        vec!["二月".to_string(), "800.5".to_string(), "00007".to_string()],
    ];

    write_xlsx(&path, &rows, "销售").expect("write xlsx");

    let names = describe(&path).expect("describe");
    assert_eq!(names, vec!["销售".to_string()]);

    let read_back = read_sheet(&path, Some("销售")).expect("read xlsx");
    assert_eq!(read_back, rows);
}

/// issue #95 的契约从 crate 外面看也一样：目标已经在了就拒绝，且原文件一个字节
/// 都不变。这里用一本**三张表**的已有文件最狠：既有“覆盖”也有“悄悄只留一张表”
/// 两种可能的事故。
#[test]
fn write_refuses_to_replace_an_existing_multi_sheet_file() {
    let dir = TempDir::new("no-overwrite-it");
    let path = dir.join("多张表.xlsx");

    // 造一本三张表的文件（不经过我们的 write，免得用被测对象造靶子）。
    let mut workbook = rust_xlsxwriter::Workbook::new();
    for name in ["销售一", "销售二", "备注"] {
        let sheet = workbook.add_worksheet();
        sheet.set_name(name).expect("set name");
        sheet.write_string(0, 0, name).expect("write cell");
    }
    workbook.save(&path).expect("save fixture");
    let before = fs::read(&path).expect("read bytes");

    let rows = vec![vec!["合计".to_string()], vec!["1200".to_string()]];
    let error = write_xlsx(&path, &rows, "合计").expect_err("必须拒绝覆盖");
    assert!(matches!(error, SheetError::AlreadyExists(_)), "{error:?}");

    // 三张表一张都没少，字节也没动。
    assert_eq!(describe(&path).expect("describe"), vec!["销售一", "销售二", "备注"]);
    assert_eq!(fs::read(&path).expect("read bytes again"), before);
}
