//! 表格读写的集成测试：只用库 API 走一遍"写 xlsx → 读回"，并确认 `describe`
//! 能报出表名。
//!
//! 放在 `tests/` 而不是 `src/sheets.rs` 里，是为了证明这套能力对 crate 外面也是
//! 可用的——`cante-sheets` 命令行的壳和 Tauri 命令都依赖同一个公开接口。

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::sheets::{describe, read_sheet, read_csv_input, write_xlsx, SheetError};

/// 本 worktree 刚编出来的 cante-sheets：真正发到她面前的就是它，所以编码与扩展名
/// 这两条要在这上面验，而不是只验库函数。
const SHEETS_BIN: &str = env!("CARGO_BIN_EXE_cante-sheets");

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

// ---------------------------------------------------------------------------
// #15 —— 真机上她最可能踩的一脚：微信/旧 Excel 导出的 GBK CSV
// ---------------------------------------------------------------------------

fn run(args: &[&str]) -> Output {
    Command::new(SHEETS_BIN).args(args).output().expect("run cante-sheets")
}

fn path_str(path: &PathBuf) -> &str {
    path.to_str().expect("临时目录路径应当是 UTF-8")
}

/// 错误消息里不许漏英文技术话：先把路径（里面本来就可能有拉丁字母）抠掉，再看剩下
/// 的拉丁字母能不能全归到「屏幕上真有的字」里。
///
/// 允许留下的只有她屏幕上真会看到、真要点的词：Excel / WPS 两个程序名，以及 .xlsx /
/// .csv 两种文件后缀——产品里已有的 WPS 消息就是这么写的。除此之外**任何**拉丁字母
/// 都是漏出来的技术话（stream / valid / utf-8 / os error …），一律判红。这是
/// 「零术语、全中文」的回归。
fn assert_no_english(message: &str, paths: &[&str]) {
    let mut text = message.to_string();
    for path in paths {
        text = text.replace(path, "");
    }
    let on_screen = ["excel", "wps", "xlsx", "csv"];
    let mut word = String::new();
    let check = |word: &mut String| {
        let lowered = word.to_lowercase();
        assert!(
            word.is_empty() || on_screen.contains(&lowered.as_str()),
            "错误消息里漏了英文「{word}」：{message}"
        );
        word.clear();
    };
    for character in text.chars() {
        if character.is_ascii_alphabetic() {
            word.push(character);
        } else {
            check(&mut word);
        }
    }
    check(&mut word);
}

/// 真机实测的 GBK 字节（“姓名,金额\n张三,12500\n”按 936 存的），它本来就不是合法 UTF-8。
const GBK_CSV: &[u8] = &[
    0xD0, 0xD5, 0xC3, 0xFB, 0x2C, 0xBD, 0xF0, 0xB6, 0xEE, 0x0A, 0xD5, 0xC5, 0xC8, 0xFD, 0x2C,
    0x31, 0x32, 0x35, 0x30, 0x30, 0x0A,
];

/// 带 BOM 的 UTF-16LE（“姓,金\n张,1\n”），同样不是合法 UTF-8。
const UTF16_CSV: &[u8] = &[
    0xFF, 0xFE, 0xD3, 0x59, 0x2C, 0x00, 0xD1, 0x91, 0x0A, 0x00, 0x20, 0x5F, 0x2C, 0x00, 0x31,
    0x00, 0x0A, 0x00,
];

#[test]
fn a_gbk_csv_is_refused_with_a_chinese_step_she_can_take() {
    let dir = TempDir::new("gbk");
    let csv = dir.join("销售数据.csv");
    fs::write(&csv, GBK_CSV).expect("写 GBK fixture");
    let output = dir.join("结果.xlsx");

    let result = run(&["write", path_str(&output), path_str(&csv)]);
    assert_eq!(result.status.code(), Some(2), "GBK 应当被拒收");
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    // 关键回归：那句 stream did not contain valid UTF-8 真的没了。
    assert_no_english(&stderr, &[path_str(&csv), path_str(&output)]);
    // 而且给得出她能做的那一步。
    assert!(stderr.contains("另存为"), "要给出怎么办：{stderr}");
    assert!(stderr.contains("xlsx"), "要说清存成什么：{stderr}");
    // 拒绝了就不能留下半个文件。
    assert!(!output.exists(), "拒绝了就不该留下文件");
}

#[test]
fn a_utf16_csv_and_a_broken_file_also_get_chinese() {
    let dir = TempDir::new("other-encodings");
    for (label, bytes) in [("utf16", UTF16_CSV), ("broken", &[0x80u8, 0x81, 0x82][..])] {
        let csv = dir.join(&format!("数据-{label}.csv"));
        fs::write(&csv, bytes).expect("写 fixture");
        let output = dir.join(&format!("结果-{label}.xlsx"));

        let result = run(&["write", path_str(&output), path_str(&csv)]);
        assert_eq!(result.status.code(), Some(2), "{label} 应当被拒收");
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        assert_no_english(&stderr, &[path_str(&csv), path_str(&output)]);
        // 两种可能都说到了：存的方式不一样，或者文件坏了；并且都给出「打开」这个动作。
        assert!(stderr.contains("打开"), "{label}：要给出能做的事：{stderr}");
        assert!(!output.exists(), "{label}：拒绝了就不该留下文件");
    }
}

#[test]
fn a_normal_utf8_csv_still_round_trips() {
    // 原有行为一条都不许回归：带 BOM 与不带 BOM 的 UTF-8 都要能过，中文一字不差。
    let dir = TempDir::new("utf8-still");
    for (label, bom) in [("bom", true), ("no-bom", false)] {
        let csv = dir.join(&format!("数据-{label}.csv"));
        let mut bytes = Vec::new();
        if bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice("姓名,金额\n张三,12500\n".as_bytes());
        fs::write(&csv, &bytes).expect("写 UTF-8 fixture");
        let output = dir.join(&format!("结果-{label}.xlsx"));

        let result = run(&["write", path_str(&output), path_str(&csv)]);
        assert_eq!(
            result.status.code(),
            Some(0),
            "{label}：stderr={}",
            String::from_utf8_lossy(&result.stderr)
        );
        let read = run(&["read", path_str(&output)]);
        assert_eq!(read.status.code(), Some(0), "{label}：读回来也要成功");
        let text = String::from_utf8_lossy(&read.stdout);
        assert!(text.contains("姓名"), "{label}：{text}");
        assert!(text.contains("张三"), "{label}：{text}");
        assert!(text.contains("12500"), "{label}：{text}");
    }
}

#[test]
fn writing_a_dot_csv_result_is_refused_in_chinese() {
    // 真机实测：write out.csv in.csv 会退出 0，却落盘一个真 xlsx 却叫 .csv 的文件，
    // 紧接着 read out.csv 又读不回来。这道闸门只在「名字与内容对不上」时拦。
    let dir = TempDir::new("out-ext");
    let csv = dir.join("数据.csv");
    fs::write(&csv, "姓名,金额\n张三,12500\n").expect("写 UTF-8 fixture");
    let output = dir.join("结果.csv");

    let result = run(&["write", path_str(&output), path_str(&csv)]);
    assert_eq!(result.status.code(), Some(2), "输出名不是 .xlsx 就要拦下");
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
    assert!(stderr.contains("xlsx"), "要说清应该用什么名字：{stderr}");
    assert!(stderr.contains("Excel"), "要用她能看懂的界面字眼：{stderr}");
    assert!(!stderr.contains("os error"), "不能把系统英文端出去：{stderr}");
    assert!(!output.exists(), "拒绝了就不该留下文件");
}

#[test]
fn the_reader_itself_says_the_file_is_not_plain_text() {
    // 库这一层也要挡住：不猜编码，直接换成中文。
    let dir = TempDir::new("lib-encoding");
    let csv = dir.join("销售数据.csv");
    fs::write(&csv, GBK_CSV).expect("写 GBK fixture");

    let error = read_csv_input(&csv).expect_err("GBK 必须被拒");
    assert!(matches!(error, SheetError::NotText(_)), "{error:?}");
    let message = error.to_string();
    assert!(!message.to_lowercase().contains("utf-8"), "{message}");
    assert!(message.contains("另存为"), "{message}");
}
