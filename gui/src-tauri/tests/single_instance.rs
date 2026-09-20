//! A second double-click must surface the window that is already open — not
//! start a twin with its own daemon.
//!
//! Why this matters is in `gui/docs/SINGLE-INSTANCE.md`: two instances share
//! one `file-safety/` store (`runs.json`, `runs/<id>/before/`), and each spawns
//! its own `cante serve`. Concurrent whole-file rewrites of `runs.json` lose
//! records, and an undo taken in one window can move or overwrite files the
//! other window just made — the exact thing 产品律 2 forbids.
//!
//! The real fix is one process, so the tests here pin the parts that decide
//! that, at three levels:
//!
//! * **Choice** — the pure `window_to_surface`: it can only ever name a window
//!   that already exists, and it has no "create" answer.
//! * **Wiring** — the second-launch callback creates neither a window nor a
//!   daemon, and the `Daemon` is created exactly once, inside the app `.setup`.
//!   Tauri initialises plugins (running their setup hooks, which is where this
//!   plugin exits the second process) before the window is created and before
//!   that `.setup` runs.
//! * **Spawn** — however many commands arrive, one `Daemon` starts exactly one
//!   child. That is the "no second daemon" gate measured on the real code path.
//!
//! What a headless test *cannot* do is double-click a real icon on a real
//! desktop. The two-process behaviour (second launch exits, first window
//! focuses) is verified on a real machine and recorded in the doc; see the
//! "没核出来的" section there for exactly which part.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{Daemon, Emitter, StartSessionArgs};
use cante_gui_lib::{window_to_surface, WindowActivation, ACTIVATE_EXISTING_WINDOW};

struct Quiet;

impl Emitter for Quiet {
    fn event(&self, _event: &Value) {}
    fn state(&self, _state: &Value) {}
    fn log(&self, _stream: &str, _line: &str) {}
    fn exit(&self, _code: Option<i32>) {}
}

// ---------------------------------------------------------------------------
// Choice: which window does a second launch surface?
// ---------------------------------------------------------------------------

#[test]
fn a_second_launch_picks_the_main_window() {
    let labels = ["settings", "main", "results"];
    assert_eq!(
        window_to_surface(&labels),
        Some("main"),
        "the app's only window is `main`; it must win over any other window"
    );
}

#[test]
fn a_second_launch_falls_back_to_an_open_window() {
    let labels = ["results"];
    assert_eq!(window_to_surface(&labels), Some("results"));
}

#[test]
fn a_second_launch_never_invents_a_window_to_open() {
    // No window at all: return nothing, so the caller shows nothing. Opening a
    // window here is the bug this whole change exists to prevent.
    assert_eq!(window_to_surface(&[]), None);

    // And whatever it returns is always one of the windows it was handed —
    // there is no path that produces a label that is not already open.
    let labels = ["one", "two", "three"];
    let chosen = window_to_surface(&labels).expect("a window is open");
    assert!(
        labels.contains(&chosen),
        "the surfaced window must already exist, got {chosen:?}"
    );
}

#[test]
fn activation_brings_the_window_back_and_never_creates_one() {
    // A minimised window stays minimised under `show`; focus has to come after
    // it is restored and shown, or the second click appears to do nothing.
    assert_eq!(
        ACTIVATE_EXISTING_WINDOW,
        [
            WindowActivation::Unminimize,
            WindowActivation::Show,
            WindowActivation::SetFocus,
        ],
        "activation order must be unminimize -> show -> focus"
    );
}

// ---------------------------------------------------------------------------
// Wiring: the gate cannot create a window or a second daemon
// ---------------------------------------------------------------------------

/// The second-launch callback only ever *surfaces* the window it is handed — it
/// never creates one.
///
/// This is the structural half of "the second double-click must not open a
/// second window". The callback body is scanned because the real callback needs
/// a live app to run; the property being pinned is that it contains no window
/// creation and no daemon start.
#[test]
fn the_second_launch_callback_never_creates_a_window_or_daemon() {
    let source = include_str!("../src/lib.rs");

    let callback = source
        .split("tauri_plugin_single_instance::init")
        .nth(1)
        .expect("lib.rs must register the single-instance plugin");
    // The plugin is registered with a one-line closure; take that statement.
    let callback = callback
        .split(".plugin(tauri_plugin_window_state")
        .next()
        .expect("the callback statement has an end");

    assert!(
        callback.contains("surface_existing_window"),
        "the second-launch callback must surface the open window"
    );
    assert!(
        !callback.contains("WebviewWindowBuilder") && !callback.contains("Daemon::new"),
        "the second-launch callback must not create a window or start a daemon"
    );
}

/// The `Daemon` is created exactly once, and only inside the app's `setup`.
///
/// The single-instance plugin runs its setup hook when Tauri initialises
/// plugins — during `Builder::build`, before the app's own `.setup` and before
/// the configured window is created. It exits the second process there. So a
/// second launch cannot reach `Daemon::new`; if this test ever sees a second
/// creation site (e.g. one outside `setup`), that guarantee is gone.
#[test]
fn the_daemon_is_created_once_and_only_in_setup() {
    let source = include_str!("../src/lib.rs");
    let creations = source.matches("daemon::Daemon::new").count();
    assert_eq!(
        creations, 1,
        "the Daemon must be created exactly once, found {creations}"
    );

    let setup = source
        .find(".setup(|app|")
        .expect("lib.rs must keep its app setup hook");
    let daemon = source
        .find("daemon::Daemon::new")
        .expect("the daemon is managed in setup");
    assert!(
        setup < daemon,
        "Daemon::new must live inside the setup hook, which plugin setup precedes"
    );
}

/// `spawn_child` has exactly one caller, and that caller is the guarded
/// `ensure_started` (`if inner.proc.is_some() { return Ok(()) }`).
///
/// "One daemon per app" is only true while this holds. A second call site —
/// e.g. a retry path that spawns without checking `proc` — would start a second
/// child per window and quietly undo the guarantee.
#[test]
fn the_daemon_has_a_single_spawn_site() {
    let source = include_str!("../src/daemon.rs");
    let calls = source.matches("spawn_child(").count();
    // One definition (`fn spawn_child(`) plus the one guarded call.
    assert_eq!(
        calls, 2,
        "expected one `spawn_child` definition and exactly one call site, found {calls}; \
         a new spawn site bypasses the `inner.proc.is_some()` guard"
    );
    assert!(
        source.contains("if inner.proc.is_some()"),
        "`ensure_started` must keep its already-running guard"
    );
}

// ---------------------------------------------------------------------------
// Spawn: many commands, one child
// ---------------------------------------------------------------------------

/// Drive the real `Daemon` and prove that several ops produce exactly one child
/// process.
///
/// The stand-in appends one line to a tally file at startup, so the number of
/// lines *is* the number of daemons started. The ops below are the ones a
/// window sends while it is waking up; each of them calls `send_op`, which is
/// the only path that can spawn. A correct daemon spawns once and reuses the
/// child; a regression that spawns per-op would write more than one line.
#[test]
fn several_commands_start_exactly_one_daemon() {
    let dir = std::env::temp_dir();
    let tally = dir.join(format!("cante-single-instance-{}.tally", std::process::id()));
    let _ = std::fs::remove_file(&tally);

    let script = dir.join(format!("cante-single-instance-{}.mjs", std::process::id()));
    let body = format!(
        "import {{ appendFileSync }} from \"node:fs\";\n\
         appendFileSync({tally:?}, \"spawn\\n\");\n\
         for await (const _chunk of process.stdin) {{}}\n",
        tally = tally
    );
    std::fs::write(&script, body).expect("write stand-in script");

    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());
    let spec = format!("\"{bun}\" \"{}\"", script.display());
    let daemon = Daemon::with_config(Arc::new(Quiet), dir.clone(), Some(spec));

    // Three ops that all need a running daemon.
    let _ = daemon.start_session(StartSessionArgs::default());
    let _ = daemon.start_session(StartSessionArgs::default());
    let _ = daemon.interrupt();

    // Wait for the first (and only legitimate) spawn to be recorded.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut lines = 0usize;
    while Instant::now() < deadline {
        lines = std::fs::read_to_string(&tally)
            .map(|text| text.lines().filter(|line| !line.is_empty()).count())
            .unwrap_or(0);
        if lines > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(lines > 0, "the first command must have started a daemon");

    // Give a per-op-spawn regression room to show up, then count once more.
    std::thread::sleep(Duration::from_millis(400));
    let final_lines = std::fs::read_to_string(&tally)
        .map(|text| text.lines().filter(|line| !line.is_empty()).count())
        .unwrap_or(0);

    let _ = daemon.shutdown();
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(&tally);

    assert_eq!(
        final_lines, 1,
        "three commands must reuse one daemon; found {final_lines} daemons started"
    );
}
