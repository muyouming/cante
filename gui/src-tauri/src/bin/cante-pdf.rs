//! `cante-pdf` —— 给助手用的薄命令行壳。
//!
//! 逻辑全在 [`cante_gui_lib::pdf`] 里，这里只负责解析参数、把结果写到 stdout。
//! 约定和 `cante-sheets` 完全一致：
//!
//! * 成功退出码 0；用法错误或失败退出码 2。
//! * 错误只写到 stderr；stdout 只放数据，这样助手能直接拿去用。
//!
//! ```text
//! cante-pdf pages <文件>
//! cante-pdf text <文件> [--pages 1-5]
//! cante-pdf merge <结果.pdf> <第一个.pdf> <第二个.pdf> …
//! cante-pdf split <文件> --pages 1-5 --out <结果.pdf>
//! cante-pdf --version
//! ```

use std::path::Path;
use std::process::ExitCode;

use cante_gui_lib::pdf::{self, PageSelection};

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
            println!("cante-pdf {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "pages" => {
            let file = args.get(1).ok_or_else(usage)?;
            let count = pdf::page_count(Path::new(file)).map_err(|error| error.to_string())?;
            println!("{count}");
            Ok(())
        }
        "text" => {
            let file = args.get(1).ok_or_else(usage)?;
            let selection = parse_pages_flag(&args[2..])?;
            let text = pdf::extract_text(Path::new(file), selection.as_ref())
                .map_err(|error| error.to_string())?;
            let trimmed = text.trim_end();
            if !trimmed.is_empty() {
                println!("{trimmed}");
            }
            // 抽不出来不能装作抽出来了：字体没有文字对照表时（CID 字体、
            // Chrome/Skia 的 Type3 字体），上面打出来的其实是乱码。给助手一个明确的
            // 信号（stderr + 退出码 3），让它停下来告诉用户"这份大概是扫描件或字体
            // 没带出文字"，而不是拿着噪声去总结原件。issue #94：Type3 以前从这条
            // 判据里漏过去了，退出码还是 0。
            if let Some(reason) = pdf::text_layer_risk(Path::new(file), &text) {
                eprintln!("警告：{reason}");
                eprintln!(
                    "建议：不要拿这段文字下结论。先告诉用户这份 PDF 的文字提不出来（大概是扫描件，或字体没有带出文字信息），并请他核对原件。"
                );
                std::process::exit(3);
            }
            Ok(())
        }
        "merge" => {
            let output = args.get(1).ok_or_else(usage)?;
            let inputs: Vec<&Path> = args[2..].iter().map(Path::new).collect();
            if inputs.len() < 2 {
                return Err(format!("合并至少要两个 PDF\n{}", usage()));
            }
            pdf::merge(Path::new(output), &inputs).map_err(|error| error.to_string())?;
            Ok(())
        }
        "split" => {
            let file = args.get(1).ok_or_else(usage)?;
            let mut selection = None;
            let mut output = None;
            let mut index = 2;
            while index < args.len() {
                match args[index].as_str() {
                    "--pages" => {
                        let value = args.get(index + 1).ok_or_else(|| {
                            format!("--pages 后面要跟页码，比如 1-5\n{}", usage())
                        })?;
                        selection =
                            Some(PageSelection::parse(value).map_err(|error| error.to_string())?);
                        index += 2;
                    }
                    "--out" => {
                        let value = args
                            .get(index + 1)
                            .ok_or_else(|| format!("--out 后面要跟保存位置\n{}", usage()))?;
                        output = Some(value.clone());
                        index += 2;
                    }
                    other => return Err(format!("不认识的参数：{other}\n{}", usage())),
                }
            }

            let output =
                output.ok_or_else(|| format!("要指定保存到哪：--out 结果.pdf\n{}", usage()))?;
            let selection = selection.unwrap_or_else(PageSelection::all);
            pdf::split(Path::new(file), &selection, Path::new(&output))
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        other => Err(format!("不认识的用法：{other}\n{}", usage())),
    }
}

/// 解析可选的 `--pages <页码>`；出现别的参数就报用法错误。
fn parse_pages_flag(args: &[String]) -> Result<Option<PageSelection>, String> {
    let mut selection = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--pages" {
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("--pages 后面要跟页码，比如 1-5\n{}", usage()))?;
            selection = Some(PageSelection::parse(value).map_err(|error| error.to_string())?);
            index += 2;
        } else {
            return Err(format!("不认识的参数：{}\n{}", args[index], usage()));
        }
    }
    Ok(selection)
}

fn usage() -> String {
    [
        "用法：",
        "  cante-pdf pages <文件>",
        "  cante-pdf text <文件> [--pages 1-5]",
        "  cante-pdf merge <结果.pdf> <第一个.pdf> <第二个.pdf> …",
        "  cante-pdf split <文件> --pages 1-5 --out <结果.pdf>",
        "  cante-pdf --version",
    ]
    .join("\n")
}
