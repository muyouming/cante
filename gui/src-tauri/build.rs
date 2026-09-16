// Cargo build script for the Tauri shell.
//
// Besides running `tauri-build`, it makes sure the resources the release bundle
// expects — `target/release/cante-sheets` and `target/release/cante-pdf` — exist
// *before* `tauri-build` validates `bundle.resources`. Both are ordinary
// `[[bin]]` targets, so they are only produced *after* this script runs;
// without the placeholders a bare `cargo test` (and the very first release
// build) would fail with `resource path target/release/<name> doesn't exist`.
// Cargo overwrites each placeholder with the real binary later in the same
// invocation, so the bundled app still ships the real tools.
use std::path::Path;

fn main() {
    seed_placeholder("cante-sheets");
    seed_placeholder("cante-pdf");
    tauri_build::build()
}

fn seed_placeholder(name: &str) {
    let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let path = Path::new(&manifest).join("target").join("release").join(name);
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, b"");
}
