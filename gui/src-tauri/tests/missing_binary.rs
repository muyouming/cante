//! A missing `cante` binary must degrade instead of crashing the shell.
//!
//! `docs-site/docs/usage/gui.mdx` promises that the window opens even when no
//! binary is found — the header shows the bridge as offline and `health` reports
//! what it tried. This pins that: nothing panics, nothing hangs, no half-spawned
//! daemon is left behind, and the failure carries the binary name so the UI can
//! show it.
use std::sync::Arc;

use serde_json::{json, Value};

use cante_gui_lib::daemon::{Daemon, Emitter, StartSessionArgs};

struct NullEmitter;

impl Emitter for NullEmitter {
    fn event(&self, _event: &Value) {}
    fn state(&self, _state: &Value) {}
    fn log(&self, _stream: &str, _line: &str) {}
    fn exit(&self, _code: Option<i32>) {}
}

fn daemon_with(bin: &str) -> Daemon {
    Daemon::with_config(
        Arc::new(NullEmitter),
        std::env::temp_dir(),
        Some(bin.to_string()),
    )
}

#[test]
fn a_missing_binary_degrades_without_panicking() {
    let missing = "/nonexistent/cante-does-not-exist";
    let daemon = daemon_with(missing);

    // health() must answer (it is the first call the UI makes) and report the
    // absence rather than propagating an error.
    let health = daemon.health();
    assert_eq!(health["daemon"], json!(false), "no process should be tracked");
    assert!(health["cante"].is_null(), "no version can be read");
    assert_eq!(health["ok"], json!(true), "health itself still answers");

    // The first op that needs the daemon fails with the binary in the message.
    let error = daemon
        .start_session(StartSessionArgs {
            model: None,
            provider: None,
            effort: None,
            permission_mode: None,
            cwd: None,
            resume_session_id: None,
        })
        .expect_err("start_session must fail when the binary is missing");
    assert!(
        error.contains("cante-does-not-exist"),
        "the error must name the binary so the UI can show it: {error}"
    );

    // ... and the failure left nothing behind: still no daemon, and the ring is
    // still readable for the (empty) transcript.
    assert_eq!(daemon.health()["daemon"], json!(false));
    let page = daemon.events_since(0);
    assert_eq!(page["events"], json!([]));
    assert_eq!(page["cursor"], json!(0));
}

#[test]
fn set_cwd_redirects_the_next_spawn() {
    let daemon = daemon_with("/nonexistent/cante-does-not-exist");
    let target = std::env::temp_dir().join("cante-gui-cwd-test");
    std::fs::create_dir_all(&target).unwrap();

    daemon.set_cwd(target.to_str().unwrap()).expect("set_cwd");

    assert_eq!(
        daemon.health()["cwd"],
        json!(target.to_string_lossy()),
        "health reports the workspace the next spawn will use"
    );
}
