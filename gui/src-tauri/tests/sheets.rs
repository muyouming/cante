//! 表格读写的集成测试：只用库 API 走一遍"写 xlsx → 读回"，并确认 `describe`
//! 能报出表名。
//!
//! 放在 `tests/` 而不是 `src/sheets.rs` 里，是为了证明这套能力对 crate 外面也是
//! 可用的——`cante-sheets` 命令行的壳和 Tauri 命令都依赖同一个公开接口。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::sheets::{describe, read_sheet, write_xlsx};

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
