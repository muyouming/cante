//! A child that closes stdout and stays alive must not wedge the daemon.
//!
//! The stdout reader treats EOF as "the daemon is gone" and finalizes the exit.
//! It used to do that while holding the daemon mutex, so a process that closed
//! its pipes but kept running blocked every later command forever — the window
//! would simply stop responding with no error anywhere.
//!
//! `gui/fixtures/closes-stdout.ts` is exactly that process.
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{Daemon, Emitter};

struct NullEmitter;

impl Emitter for NullEmitter {
    fn event(&self, _event: &Value) {}
    fn state(&self, _state: &Value) {}
    fn log(&self, _stream: &str, _line: &str) {}
    fn exit(&self, _code: Option<i32>) {}
}

#[test]
fn a_child_that_closes_stdout_does_not_block_later_commands() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/closes-stdout.ts");
    assert!(fixture.exists(), "fixture missing: {}", fixture.display());
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());

    let daemon = Daemon::with_config(
        Arc::new(NullEmitter),
        std::env::temp_dir(),
        Some(format!("{bun} {}", fixture.display())),
    );

    // Spawning is what starts the reader; the write may fail on a closed pipe,
    // which is fine — the point is the state the reader lands in.
    let _ = daemon.start_session(Default::default());
    std::thread::sleep(Duration::from_millis(750));

    // Before the fix this blocked on the mutex until the child died (never).
    let started = Instant::now();
    let page = daemon.events_since(0);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "events_since blocked for {elapsed:?} — the exit finalizer is holding the lock"
    );
    assert_eq!(page["state"]["status"], "offline", "the reader must mark it gone");
    assert!(page["state"]["session"].is_null());

    // And a fresh command still answers (a new daemon spawns on demand).
    assert!(daemon.health()["daemon"].is_boolean());
    let _ = daemon.shutdown();
}
