//! `cante-bridge` —— 用 `pi --mode rpc` 顶替 `cante serve` 的薄壳。
//!
//! `daemon.rs` 把 `CANTE_BIN` 当命令规格，并在后面追加它自己的子命令，所以
//! 这个二进制只认三种调用：
//!
//! ```text
//! cante-bridge serve      # 协议适配器本体（stdin/stdout 走 Op/Evt JSONL）
//! cante-bridge --version  # health 探活（前端只判断这一行非空）
//! cante-bridge catalog    # 服务方清单；这一段返回空，前端不调
//! ```
//!
//! 逻辑全在 [`cante_gui_lib::bridge`] 里，这里只做分发。

use std::process::ExitCode;

use cante_gui_lib::bridge;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("{}", bridge::VERSION);
            ExitCode::SUCCESS
        }
        // The provider list is not wired up in this segment: returning an empty
        // list is honest, and no product path reads it (`catalog` has no caller
        // in the frontend, see docs/DECISION-windows-runtime.md §1.2).
        Some("catalog") => {
            println!("{{\"providers\":[]}}");
            ExitCode::SUCCESS
        }
        // `daemon.rs` appends `serve`; a bare invocation runs it too so the
        // binary is usable by hand.
        Some("serve") | None => ExitCode::from(bridge::serve() as u8),
        Some(other) => {
            eprintln!("cante-bridge: unknown subcommand: {other}");
            ExitCode::from(2)
        }
    }
}
