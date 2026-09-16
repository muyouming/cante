//! 表格读写（issue #75）。
//!
//! 简单模式承诺的旗舰任务——"把两张销售表合成一张，另存成 .xlsx"——此前卡在最后
//! 一步：这台电脑根本没有能写 xlsx 的东西。这个模块就是那块缺失的能力，纯逻辑 +
//! 文件 IO，不打印、不退出，方便 `cargo test` 直接测，也给 `cante-sheets` 命令行
//! 壳和 Tauri 命令共用。
//!
//! 读取用 [`calamine`]（xlsx / xls / xlsb / ods 都能读），写入用
//! [`rust_xlsxwriter`]（纯 Rust，不需要装 Office，也不需要解释器）。取值时尽量
//! 保住原意：日期还原成 `YYYY-MM-DD`，整数不写成 `1200.0`，文本里的前导 0 原样
//! 保留——因为这些小地方的走样，在王姐眼里就是"数据错了"。
//!
//! 所有错误消息都是中文，读得懂，例如：
//! `文件不存在：/tmp/x.xlsx`、`这个格式我读不了：x.pdf`、
//! `这个文件像是坏了，读不开：/tmp/x.xlsx`。

use std::fmt;
use std::io::BufReader;
use std::path::Path;

use calamine::{open_workbook_auto, Data, ExcelDateTime, Reader as _, Sheets};
use rust_xlsxwriter::{ExcelDateTime as XlsxDateTime, Format, Workbook};

/// 能读的扩展名（小写）；不在这个名单里的格式直接说"读不了"，而不是硬试。
const SUPPORTED_EXTENSIONS: &[&str] = &["xls", "xla", "xlsx", "xlsm", "xlam", "xlsb", "ods"];

/// WPS 自己的格式：`.et` 表格、`.ett` 模板、`.wps` 文字、`.dps` 演示。国内办公大量用
/// WPS，所以这类文件是她最可能交过来的之一；它们是好的文件，只是底层不是
/// OOXML/BIFF，读不了——因此单独给一条"怎么办"的话，而不是笼统地说读不了。
const WPS_EXTENSIONS: &[&str] = &["et", "ett", "wps", "dps"];

/// 没给表名时写进 xlsx 的默认表名。
const DEFAULT_SHEET_NAME: &str = "Sheet1";

/// 工作簿里有哪些表。保留这个结构体，是为了让调用方有一个明确的"表清单"类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetDescription {
    pub sheets: Vec<String>,
}

/// 读表时可能出的问题。`Display` 全中文，直接可以给用户看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SheetError {
    /// 文件根本不在。
    NotFound(String),
    /// 这个扩展名我们不认识 / 读不了。
    Unsupported(String),
    /// WPS 自己的表格格式（`.et` 等）：文件是好的，只是**不是 Excel 格式**。
    /// 而她多半就是拿 WPS 做的表，所以要说清"怎么办"，不能只说读不了。
    WpsFormat(String),
    /// 文件在，但打不开（坏了、加密了、表名对不上……）。
    Broken(String),
}

impl fmt::Display for SheetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SheetError::NotFound(path) => write!(f, "文件不存在：{path}"),
            SheetError::Unsupported(path) => write!(f, "这个格式我读不了：{path}"),
            SheetError::WpsFormat(path) => write!(
                f,
                "这是 WPS 表格自己的格式（不是 Excel 格式），我读不了：{path}。在 WPS 里打开它，点「另存为」选 Excel 文件（.xlsx），再把新文件交给我就行。"
            ),
            SheetError::Broken(what) => write!(f, "这个文件像是坏了，读不开：{what}"),
        }
    }
}

impl std::error::Error for SheetError {}

/// 一个工作簿，按路径自动判断格式。
type Spreadsheet = Sheets<BufReader<std::fs::File>>;

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/// 列出这个文件里所有表的表名，按文件里的顺序。
///
/// 文件不存在 → [`SheetError::NotFound`]；格式不认识 → [`SheetError::Unsupported`]；
/// 打不开 → [`SheetError::Broken`]。
pub fn describe(path: &Path) -> Result<Vec<String>, SheetError> {
    let workbook = open(path)?;
    Ok(workbook.sheet_names())
}

/// 读一张表，返回一行行的文本。默认读第一张表；`sheet` 给了名字就读那一张。
///
/// 取值规则（尽量保住原意）：
/// * 日期 / 时间 → `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`（不是 Excel 序列号）；
/// * 整数 → `1200`（不是 `1200.0`）；
/// * 小数 → 原来的精度（`800.5`）；
/// * 文本里的前导 0 原样保留（`00123` 不会变成 `123`）；
/// * 空单元格 → 空字符串；布尔 → `TRUE` / `FALSE`。
pub fn read_sheet(path: &Path, sheet: Option<&str>) -> Result<Vec<Vec<String>>, SheetError> {
    let mut workbook = open(path)?;
    let names = workbook.sheet_names();
    let target = match sheet {
        Some(name) if !name.is_empty() => {
            if !names.iter().any(|existing| existing == name) {
                let existing = if names.is_empty() {
                    "一张表也没有".to_string()
                } else {
                    format!("现有表：{}", names.join("、"))
                };
                return Err(SheetError::Broken(format!(
                    "{}（里面没有叫「{}」的表，{}）",
                    path.display(),
                    name,
                    existing
                )));
            }
            name.to_string()
        }
        _ => match names.first() {
            Some(first) => first.clone(),
            None => {
                return Err(SheetError::Broken(format!(
                    "{}（这个文件里一张表都没有）",
                    path.display()
                )))
            }
        },
    };

    let range = workbook.worksheet_range(&target).map_err(|error| {
        SheetError::Broken(format!(
            "{}（读「{}」这张表的时候出错：{}）",
            path.display(),
            target,
            error
        ))
    })?;

    Ok(range.rows().map(|row| row.iter().map(cell_to_string).collect()).collect())
}

/// 打开一个工作簿，并把"文件不存在 / 格式不认识 / 打不开"分开说清楚。
fn open(path: &Path) -> Result<Spreadsheet, SheetError> {
    if !path.exists() {
        return Err(SheetError::NotFound(path.display().to_string()));
    }
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        let lowered = extension.to_ascii_lowercase();
        if WPS_EXTENSIONS.contains(&lowered.as_str()) {
            return Err(SheetError::WpsFormat(path.display().to_string()));
        }
        if !SUPPORTED_EXTENSIONS.contains(&lowered.as_str()) {
            return Err(SheetError::Unsupported(path.display().to_string()));
        }
    }
    open_workbook_auto(path).map_err(|_| SheetError::Broken(path.display().to_string()))
}

/// 把一个单元格变成文本，尽量保住原意。
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.clone(),
        Data::Int(value) => value.to_string(),
        Data::Float(value) => format_number(*value),
        Data::Bool(value) => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Data::DateTime(value) => format_datetime(value),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
        Data::Error(value) => value.to_string(),
    }
}

/// 整数不带 `.0`，小数保留原来的精度。
fn format_number(value: f64) -> String {
    // Excel 里所有数字本质都是 double。整数值如果还在 2^53 以内，就当成整数显示，
    // 免得 `1200` 变成 `1200.0`；再大的数保持 `{}` 的输出，避免强转丢精度。
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// 日期 → `YYYY-MM-DD`；带时分秒 → `YYYY-MM-DD HH:MM:SS`；纯时长 → `HH:MM:SS`。
fn format_datetime(value: &ExcelDateTime) -> String {
    if value.is_duration() {
        let total_seconds = (value.as_f64() * 86_400.0).round() as i64;
        let hours = total_seconds / 3_600;
        let minutes = (total_seconds % 3_600) / 60;
        let seconds = total_seconds % 60;
        return format!("{hours:02}:{minutes:02}:{seconds:02}");
    }
    let (year, month, day, hour, minute, second, _milli) = value.to_ymd_hms_milli();
    if hour == 0 && minute == 0 && second == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    }
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/// 把一行行文本写成一张 .xlsx 表。第一行按表头处理（只是原样写进去）。
///
/// 看起来是普通数字的格子会写成数字（这样 Excel 里还能继续算），但带前导 0 的
/// 文本（`00123`）写成文本，免得被 Excel 吃掉开头的 0。
pub fn write_xlsx(path: &Path, rows: &[Vec<String>], sheet_name: &str) -> Result<(), SheetError> {
    let trimmed = sheet_name.trim();
    let name = if trimmed.is_empty() { DEFAULT_SHEET_NAME } else { trimmed };

    // 日期格式只建一次：`yyyy-mm-dd` 与我们读出来的写法一致，往返稳定。
    let date_format = Format::new().set_num_format("yyyy-mm-dd");
    let mut workbook = Workbook::new();
    {
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(name).map_err(|error| {
            SheetError::Broken(format!("{}（表名「{}」用不了：{}）", path.display(), name, error))
        })?;

        for (row_index, cells) in rows.iter().enumerate() {
            let row = row_index as u32;
            for (column_index, cell) in cells.iter().enumerate() {
                let column = column_index as u16;
                if cell.is_empty() {
                    continue;
                }
                if let Some((year, month, day)) = iso_date_literal(cell) {
                    let value = XlsxDateTime::from_ymd(year as u16, month as u8, day as u8).map_err(|error| {
                        SheetError::Broken(format!("{}（日期写不进去：{}）", path.display(), error))
                    })?;
                    worksheet
                        .write_datetime_with_format(row, column, &value, &date_format)
                        .map_err(|error| {
                            SheetError::Broken(format!("{}（写不进去：{}）", path.display(), error))
                        })?;
                } else if let Some(number) = number_literal(cell) {
                    worksheet.write_number(row, column, number).map_err(|error| {
                        SheetError::Broken(format!("{}（写不进去：{}）", path.display(), error))
                    })?;
                } else {
                    worksheet.write_string(row, column, cell).map_err(|error| {
                        SheetError::Broken(format!("{}（写不进去：{}）", path.display(), error))
                    })?;
                }
            }
        }
    }

    workbook.save(path).map_err(|error| {
        SheetError::Broken(format!("{}（写不进去：{}）", path.display(), error))
    })?;
    Ok(())
}

/// 如果这个字符串是"普通数字"，返回它的数值；否则返回 `None`（按文本写）。
///
/// `00123`、`1200.0`、`1e5` 这类不规范的写法一律当成文本，写进去什么样，读回来
/// 还是什么样。
fn number_literal(cell: &str) -> Option<f64> {
    if cell.is_empty() {
        return None;
    }
    // 只接受"干干净净的十进制数"：可选负号 + 整数部分 + 可选小数部分。
    // 明确**不**当成数字的写法，以及为什么不：
    //   `00123`   前导 0 —— 那是编号/工号，写成数字会把 0 吃掉（她最恨这个）
    //   ` 1200`   带空格 —— 空格是她表里真实的内容，不许替她"修好"
    //   `1,200`   千分位 —— 含义随语言环境变（也可能是编号），宁可保持原样
    //   `1e3`     科学计数 —— 报告里几乎不会这么写，含义可疑
    //   `12%`     百分号 —— 要变成 0.12 再加百分比格式，属于"替她改数据"
    // 但 `2040.00` / `0.50` / `-300.00` **必须**是数字：财务表里金额就是这么写的，
    // 写成文本的话她在 Excel 里一求和会得到 0 —— 而她只会求和。
    let unsigned = cell.strip_prefix('-').unwrap_or(cell);
    let (int_part, frac_part) = match unsigned.split_once('.') {
        Some((int_part, frac_part)) => (int_part, Some(frac_part)),
        None => (unsigned, None),
    };
    if int_part.is_empty() || !int_part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if int_part.len() > 1 && int_part.starts_with('0') {
        return None;
    }
    if let Some(frac_part) = frac_part {
        if frac_part.is_empty() || !frac_part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
    }
    let value: f64 = cell.parse().ok()?;
    if !value.is_finite() || value.abs() > 9_007_199_254_740_992.0 {
        return None;
    }
    Some(value)
}

/// 这个月有几天（含闰年）。自己算而不是借库：读库与写库各有一个同名日期类型，
/// 这里不该为了一行校验去挑一个背上来。
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

/// 只认 `YYYY-MM-DD` 这一种写法，并且**必须是合法日期**（2 月 30 日不算）。
///
/// 为什么只认这一种：它无歧义（不像 `2026/7/1` 或 `07/01/2026` 那样随语言环境变），
/// 而且正是我们自己读表时统一输出的形式。所以"读出来再写回去"能把日期**还原成
/// 真日期**，她在 Excel 里排序、算天数都照常；其它写法一律保持文本，不替她猜。
fn iso_date_literal(cell: &str) -> Option<(i32, u32, u32)> {
    let bytes = cell.as_bytes();
    if bytes.len() != 10 {
        return None;
    }
    let shaped = bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !shaped {
        return None;
    }
    let year = cell[0..4].parse::<i32>().ok()?;
    let month = cell[5..7].parse::<u32>().ok()?;
    let day = cell[8..10].parse::<u32>().ok()?;
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

// ---------------------------------------------------------------------------
// CSV（标准引号规则，往返一致）
// ---------------------------------------------------------------------------

/// 把一行行文本变成 CSV 文本。含逗号、引号或换行的格子会加引号，引号内部再转义。
pub fn rows_to_csv(rows: &[Vec<String>]) -> String {
    rows.iter()
        .map(|row| row.iter().map(|field| csv_field(field)).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 解析 CSV 文本，返回一行行格子。能读回 [`rows_to_csv`] 写出去的内容。
///
/// Excel 在 Windows 上导出的 CSV 常带一个开头的 BOM，这里先去掉，免得表头变成
/// `\u{feff}姓名`。
pub fn csv_to_rows(input: &str) -> Vec<Vec<String>> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut dirty = false;
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        if in_quotes {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(character);
            }
            dirty = true;
            continue;
        }

        match character {
            '"' => {
                in_quotes = true;
                dirty = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                dirty = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                dirty = false;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                dirty = false;
            }
            _ => {
                field.push(character);
                dirty = true;
            }
        }
    }

    if dirty {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// 单个格子的 CSV 写法。
fn csv_field(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rust_xlsxwriter::{ExcelDateTime, Format};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// 每个测试一个独一无二的临时目录，退出时自动删。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0);
            let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("cante-sheets-{label}-{stamp}-{serial}"));
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

    fn rows(values: &[&[&str]]) -> Vec<Vec<String>> {
        values.iter().map(|row| row.iter().map(|cell| cell.to_string()).collect()).collect()
    }

    #[test]
    fn round_trip_keeps_values() {
        let dir = TempDir::new("round-trip");
        let path = dir.join("结果.xlsx");
        let original = rows(&[
            &["姓名", "数量", "单价", "编号"],
            &["张三", "1200", "800.5", "00123"],
            &["李四", "", "7", "00007"],
        ]);

        write_xlsx(&path, &original, "销售 2026").expect("write");
        let read_back = read_sheet(&path, None).expect("read");

        assert_eq!(read_back, original);
        // 前导 0 保真。
        assert_eq!(read_back[1][3], "00123");
        // 整数不带 .0。
        assert_eq!(read_back[1][1], "1200");
        assert!(!read_back[1][1].contains('.'));
        // 小数保留原精度。
        assert_eq!(read_back[1][2], "800.5");
        // 空单元格是空字符串。
        assert_eq!(read_back[2][1], "");
    }

    #[test]
    fn describe_lists_chinese_sheet_names() {
        let dir = TempDir::new("describe-cn");
        let path = dir.join("表.xlsx");
        write_xlsx(&path, &rows(&[&["一"]]), "销售 2026").expect("write");

        let names = describe(&path).expect("describe");
        assert_eq!(names, vec!["销售 2026".to_string()]);
        assert_eq!(read_sheet(&path, Some("销售 2026")).expect("read"), rows(&[&["一"]]));
    }

    #[test]
    fn multiple_sheets_can_be_listed_and_read() {
        let dir = TempDir::new("multi-sheet");
        let path = dir.join("多张表.xlsx");

        let mut workbook = Workbook::new();
        let first = workbook.add_worksheet();
        first.set_name("第一张").expect("name");
        first.write_string(0, 0, "A").expect("write");
        let second = workbook.add_worksheet();
        second.set_name("第二张").expect("name");
        second.write_string(0, 0, "B").expect("write");
        workbook.save(&path).expect("save");

        let names = describe(&path).expect("describe");
        assert_eq!(names, vec!["第一张".to_string(), "第二张".to_string()]);
        assert_eq!(read_sheet(&path, None).expect("default"), rows(&[&["A"]]));
        assert_eq!(read_sheet(&path, Some("第二张")).expect("named"), rows(&[&["B"]]));
        assert!(read_sheet(&path, Some("没有这张")).is_err());
    }

    #[test]
    fn dates_come_back_as_plain_dates() {
        let dir = TempDir::new("dates");
        let path = dir.join("日期.xlsx");

        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        let date_format = Format::new().set_num_format("yyyy-mm-dd");
        sheet
            .write_datetime_with_format(
                0,
                0,
                ExcelDateTime::from_ymd(2026, 7, 1).expect("date"),
                &date_format,
            )
            .expect("write date");
        workbook.save(&path).expect("save");

        let read_back = read_sheet(&path, None).expect("read");
        assert_eq!(read_back[0][0], "2026-07-01");
    }

    #[test]
    fn booleans_are_true_or_false() {
        let dir = TempDir::new("bools");
        let path = dir.join("布尔.xlsx");

        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet.write_boolean(0, 0, true).expect("true");
        sheet.write_boolean(0, 1, false).expect("false");
        workbook.save(&path).expect("save");

        assert_eq!(read_sheet(&path, None).expect("read"), rows(&[&["TRUE", "FALSE"]]));
    }

    #[test]
    fn csv_quotes_commas_quotes_and_newlines() {
        let original = rows(&[
            &["姓名", "备注"],
            &["张三", "北京, 朝阳"],
            &["李四", "他说\"好\""],
            &["王五", "第一行\n第二行"],
        ]);
        let csv = rows_to_csv(&original);
        assert!(csv.contains("\"北京, 朝阳\""));
        assert!(csv.contains("\"他说\"\"好\"\"\""));
        assert!(csv.contains("\"第一行\n第二行\""));
        assert_eq!(csv_to_rows(&csv), original);
    }

    #[test]
    fn csv_round_trip_is_stable() {
        let original = rows(&[&["a", "b", ""], &["1", "x,y", "z\"w"]]);
        assert_eq!(csv_to_rows(&rows_to_csv(&original)), original);
    }

    #[test]
    fn csv_ignores_a_leading_bom() {
        assert_eq!(
            csv_to_rows("\u{feff}姓名,数量\n张三,1"),
            rows(&[&["姓名", "数量"], &["张三", "1"]])
        );
    }

    #[test]
    fn extreme_integers_stay_text_and_do_not_panic() {
        let dir = TempDir::new("extreme");
        let path = dir.join("极端.xlsx");
        let original = rows(&[&["大数"], &["-9223372036854775808"], &["99999999999999999999"]]);
        write_xlsx(&path, &original, "Sheet1").expect("write");
        assert_eq!(read_sheet(&path, None).expect("read"), original);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = TempDir::new("missing");
        let path = dir.join("没有这个文件.xlsx");
        match describe(&path) {
            Err(SheetError::NotFound(reported)) => {
                assert_eq!(reported, path.display().to_string());
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(describe(&path).unwrap_err().to_string().contains("文件不存在"));
    }

    #[test]
    fn money_written_with_two_decimals_stays_a_number() {
        // 财务表里的金额通常写成 `2040.00`。它必须是**数字**，否则她在 Excel 里
        // 一求和会得到 0 —— 而求和是她唯一熟练的操作。
        assert_eq!(number_literal("2040.00"), Some(2040.0));
        assert_eq!(number_literal("-300.00"), Some(-300.0));
        assert_eq!(number_literal("0.50"), Some(0.5));
        assert_eq!(number_literal("1200"), Some(1200.0));
        assert_eq!(number_literal("1200.5"), Some(1200.5));

        // 这些必须保持文本，理由写在 number_literal 的注释里。
        for text in ["00123", " 1200", "1200 ", "1,200", "1e3", "12%", "2026-07-01", "", "-", ".5", "1.", "五"] {
            assert_eq!(number_literal(text), None, "{text:?} 不该被当成数字");
        }
    }

    #[test]
    fn iso_dates_come_back_as_real_dates() {
        // 只认 ISO 写法，而且必须是合法日期。
        assert_eq!(iso_date_literal("2026-07-01"), Some((2026, 7, 1)));
        assert_eq!(iso_date_literal("2024-02-29"), Some((2024, 2, 29)));
        assert_eq!(iso_date_literal("2026-02-30"), None, "2 月 30 日不是合法日期");
        assert_eq!(iso_date_literal("2026-13-01"), None);
        for text in ["2026/07/01", "07/01/2026", "2026-7-1", "20260701", "2026-07-01 09:00", ""] {
            assert_eq!(iso_date_literal(text), None, "{text:?} 不该被当成日期");
        }
        // 汉字不能让它 panic（切片必须落在字符边界上）。
        assert_eq!(iso_date_literal("二〇二六年七月"), None);
    }

    #[test]
    fn wps_formats_are_told_what_to_do_instead_of_just_refused() {
        let dir = TempDir::new("wps");
        // 内容无所谓：扩展名就不该走到解析那一步，而她是用 WPS 做的表。
        let path = dir.join("销售表.et");
        std::fs::write(&path, b"not really a spreadsheet").expect("write");
        let message = read_sheet(&path, None).expect_err("must refuse").to_string();
        assert!(message.contains("WPS"), "要说是 WPS 的格式：{message}");
        assert!(message.contains("另存为"), "要给出怎么办：{message}");
        assert!(message.contains("xlsx"), "要说清存成什么：{message}");
        assert!(!message.contains("坏了"), "文件是好的，不能说她的文件坏了：{message}");
    }

    #[test]
    fn pdf_is_unsupported() {
        let dir = TempDir::new("pdf");
        let path = dir.join("x.pdf");
        fs::write(&path, b"%PDF-1.4 not a spreadsheet").expect("write");
        match describe(&path) {
            Err(SheetError::Unsupported(reported)) => {
                assert_eq!(reported, path.display().to_string());
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
        assert!(describe(&path).unwrap_err().to_string().contains("读不了"));
    }

    #[test]
    fn broken_xlsx_is_reported_as_broken() {
        let dir = TempDir::new("broken");
        let path = dir.join("坏文件.xlsx");
        fs::write(&path, b"this is definitely not a zip").expect("write");
        assert!(matches!(describe(&path), Err(SheetError::Broken(_))));
    }
}
