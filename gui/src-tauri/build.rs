// Cargo build script for the Tauri shell.
//
// Besides running `tauri-build`, it makes sure the resource the release bundle
// expects — `target/release/cante-sheets` — exists *before* `tauri-build`
// validates `bundle.resources`. `cante-sheets` is an ordinary `[[bin]]` target,
// so it is only produced *after* this script runs; without the placeholder a
// bare `cargo test` (and the very first release build) would fail with
// `resource path target/release/cante-sheets doesn't exist`. Cargo overwrites
// the placeholder with the real binary later in the same invocation, so the
// bundled app still ships the real tool.
use std::path::PathBuf;

fn main() {
    seed_sheet_placeholder();
    tauri_build::build()
}

fn seed_sheet_placeholder() {
    let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let path = PathBuf::from(manifest).join("target").join("release").join("cante-sheets");
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, b"");
}
