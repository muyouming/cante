//! `cante-sheets` —— 给助手用的薄命令行壳。
//!
//! 逻辑全在 [`cante_gui_lib::sheets`] 里，这里只负责解析参数、读文件、把结果写到
//! stdout。约定很硬：
//!
//! * 成功退出码 0；用法错误或失败退出码 2。
//! * 错误只写到 stderr；stdout 只放数据（CSV 不带 BOM），这样助手能直接拿去用。
//! * `write` **只新建**文件，目标已经在了就报中文错误并退出 2，绝不覆盖原文件
//!   （issue #95）。一次只写一张表。
//!
//! ```text
//! cante-sheets sheets <file>
//! cante-sheets read <file> [--sheet <name>]
//! cante-sheets write <out.xlsx> <in.csv> [--sheet <name>]
//! cante-sheets --version
//! ```

use std::path::Path;
use std::process::ExitCode;

use cante_gui_lib::sheets;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else {
        return Err(usage());
    };

    match command {
        "--version" | "-V" => {
            println!("cante-sheets {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "sheets" => {
            let file = args.get(1).ok_or_else(usage)?;
            let names =
                sheets::describe(Path::new(file)).map_err(|error| sheets::error_stderr(&error))?;
            for name in names {
                println!("{name}");
            }
            Ok(())
        }
        "read" => {
            let file = args.get(1).ok_or_else(usage)?;
            let sheet = parse_sheet_flag(&args[2..])?;
            let rows = sheets::read_sheet(Path::new(file), sheet.as_deref())
                .map_err(|error| sheets::error_stderr(&error))?;
            let csv = sheets::rows_to_csv(&rows);
            if !csv.is_empty() {
                println!("{csv}");
            }
            Ok(())
        }
        "write" => {
            let output = args.get(1).ok_or_else(usage)?;
            let input = args.get(2).ok_or_else(usage)?;
            let sheet = parse_sheet_flag(&args[3..])?;
            // 结果名先过闸门：名字和数据对不上会产出一个自己也读不回去的文件。
            sheets::check_output_name(Path::new(output))
                .map_err(|error| sheets::error_stderr(&error))?;
            let text = sheets::read_csv_input(Path::new(input))
                .map_err(|error| sheets::error_stderr(&error))?;
            let rows = sheets::csv_to_rows(&text);
            let name = sheet.as_deref().unwrap_or(sheets::DEFAULT_SHEET_NAME);
            sheets::write_xlsx(Path::new(output), &rows, name)
                .map_err(|error| sheets::error_stderr(&error))?;
            Ok(())
        }
        other => Err(format!("不认识的用法：{other}\n{}", usage())),
    }
}

/// 解析可选的 `--sheet <表名>`；出现别的参数就报用法错误。
fn parse_sheet_flag(args: &[String]) -> Result<Option<String>, String> {
    let mut sheet = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--sheet" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("--sheet 后面要跟一个表名\n{}", usage()))?;
            sheet = Some(value.clone());
            index += 2;
        } else {
            return Err(format!("不认识的参数：{}\n{}", args[index], usage()));
        }
    }
    Ok(sheet)
}

fn usage() -> String {
    [
        "用法：",
        "  cante-sheets sheets <文件>",
        "  cante-sheets read <文件> [--sheet <表名>]",
        "  cante-sheets write <结果.xlsx> <数据.csv> [--sheet <表名>]",
        "",
        "注意：write 只在 <结果.xlsx> 还不存在时新建它；已经有同名文件就报错退出（2），",
        "不会覆盖。请换一个新文件名再试。",
        "cante-sheets --version",
    ]
    .join("\n")
}
