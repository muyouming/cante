//! `CANTE_BIN` is a command spec, not just a path.
//!
//! Windows cannot execute a `#!` script directly, so the tests point `CANTE_BIN`
//! at `"bun <script>"`; the daemon appends its own `serve` subcommand after the
//! leading arguments. Paths may be quoted because a Windows path may contain
//! spaces, and a spec may carry a whole shell command line because Windows has
//! no Linux build of `cante` — the daemon then lives in WSL and is reached
//! through `wsl.exe`. These three shapes are the ones we actually hand people:
//!
//! - `wsl.exe -e /home/win11/cante-bin/ante serve`
//! - `"C:\Program Files\cante\cante.exe" serve`
//! - `wsl.exe -d Ubuntu -e bash -lc 'cd /home/x && ./ante serve'`
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{helper_argv, serve_argv, split_binary, Daemon, Emitter, StartSessionArgs};

#[test]
fn a_bare_program_has_no_arguments() {
    let (program, args) = split_binary("cante");
    assert_eq!(program, "cante");
    assert!(args.is_empty());
}

#[test]
fn leading_arguments_are_kept_in_order() {
    let (program, args) = split_binary("bun /opt/fixtures/fake-cante.ts");
    assert_eq!(program, "bun");
    assert_eq!(args, vec!["/opt/fixtures/fake-cante.ts".to_string()]);
}

#[test]
fn quoted_tokens_survive_spaces() {
    let (program, args) = split_binary(r#""C:\Program Files\bun\bun.exe" "C:\my scripts\fake-cante.ts""#);
    assert_eq!(program, r"C:\Program Files\bun\bun.exe");
    assert_eq!(args, vec![r"C:\my scripts\fake-cante.ts".to_string()]);
}

#[test]
fn extra_whitespace_is_ignored() {
    let (program, args) = split_binary("   bun    script.ts   ");
    assert_eq!(program, "bun");
    assert_eq!(args, vec!["script.ts".to_string()]);
}

#[test]
fn an_empty_spec_falls_back_to_the_default_binary() {
    let (program, args) = split_binary("   ");
    assert_eq!(program, "cante");
    assert!(args.is_empty());
}

// ---------------------------------------------------------------------------
// The WSL bridge: the same spec has to mean one command, not two
// ---------------------------------------------------------------------------

/// The value AGENTS.md §6 tells a Windows user to set. It already ends with the
/// daemon's own subcommand; spawning must not turn it into `ante serve serve`.
#[test]
fn a_spec_that_names_serve_is_not_doubled() {
    let (program, args) = serve_argv("wsl.exe -e /home/win11/cante-bin/ante serve");
    assert_eq!(program, "wsl.exe");
    assert_eq!(args, ["-e", "/home/win11/cante-bin/ante", "serve"]);
}

/// The other shape: a spec with no subcommand of its own gets exactly one.
#[test]
fn a_spec_without_serve_gets_exactly_one() {
    let (program, args) = serve_argv("bun /opt/fixtures/fake-cante.ts");
    assert_eq!(program, "bun");
    assert_eq!(args, ["/opt/fixtures/fake-cante.ts", "serve"]);
}

#[test]
fn a_quoted_windows_program_keeps_its_serve() {
    let (program, args) = serve_argv(r#""C:\Program Files\cante\cante.exe" serve"#);
    assert_eq!(program, r"C:\Program Files\cante\cante.exe");
    assert_eq!(args, ["serve"]);
}

/// Single quotes are quoting too: without that rule the `-lc` payload would be
/// shredded into `'cd`, `/home/x`, `&&`, `./ante`, `serve'` — five arguments
/// where the shell wanted one, and bash would run `cd` and a bare `./ante`.
#[test]
fn a_single_quoted_shell_payload_stays_one_argument() {
    let spec = "wsl.exe -d Ubuntu -e bash -lc 'cd /home/x && ./ante serve'";
    let (program, args) = serve_argv(spec);
    assert_eq!(program, "wsl.exe");
    assert_eq!(args.len(), 6, "the payload must not be shredded: {args:?}");
    assert_eq!(args[..5], ["-d", "Ubuntu", "-e", "bash", "-lc"]);
    assert_eq!(args[5], "cd /home/x && ./ante serve");
}

/// A payload that already carries the subcommand gets nothing appended — the
/// payload is the whole command line, so an extra `serve` could only end up as
/// bash's `$0`.
#[test]
fn a_shell_payload_is_not_given_a_second_serve() {
    let (_, args) = serve_argv("wsl.exe -d Ubuntu -e bash -lc 'cd /home/x && ./ante serve'");
    assert_eq!(args.last().unwrap(), "cd /home/x && ./ante serve");
}

/// A double-quoted payload works the same way (PowerShell users write these).
#[test]
fn a_double_quoted_shell_payload_stays_one_argument() {
    let (program, args) = serve_argv(r#"wsl.exe -d Ubuntu -e bash -lc "cd /home/x && ./ante serve""#);
    assert_eq!(program, "wsl.exe");
    assert_eq!(args, ["-d", "Ubuntu", "-e", "bash", "-lc", "cd /home/x && ./ante serve"]);
}

// ---------------------------------------------------------------------------
// The out-of-process helpers (`--version`, `catalog`)
// ---------------------------------------------------------------------------

/// `ante serve --version` is not a thing, so the spec's own `serve` is dropped
/// and the helper flag takes its place — otherwise a WSL bridge would show an
/// unknown version and an empty provider catalog.
#[test]
fn a_helper_flag_replaces_the_specs_serve() {
    let (program, args) = helper_argv("wsl.exe -e /home/win11/cante-bin/ante serve", &["--version"]);
    assert_eq!(program, "wsl.exe");
    assert_eq!(args, ["-e", "/home/win11/cante-bin/ante", "--version"]);
}

#[test]
fn a_helper_flag_follows_the_leading_arguments() {
    let (program, args) = helper_argv("bun /opt/fixtures/fake-cante.ts", &["catalog"]);
    assert_eq!(program, "bun");
    assert_eq!(args, ["/opt/fixtures/fake-cante.ts", "catalog"]);
}

#[test]
fn a_quoted_windows_program_can_be_probed() {
    let (program, args) = helper_argv(r#""C:\Program Files\cante\cante.exe" serve"#, &["--version"]);
    assert_eq!(program, r"C:\Program Files\cante\cante.exe");
    assert_eq!(args, ["--version"]);
}

// ---------------------------------------------------------------------------
// The Windows bridge: `cante-bridge.exe` in front of `pi`
// ---------------------------------------------------------------------------
//
// On a Windows machine without the upstream daemon, the value we hand people is
// the path of this crate's own bridge binary — `C:\path\cante-bridge.exe` — and
// nothing else. The daemon still appends its own `serve` and still probes
// `--version` / `catalog` in front of the subcommand, so all three shapes are
// spelled out here on the exact string a Windows user will set. Pure parsing,
// so these run on any host (the executable itself cannot be spawned here).

/// The bare spec: a Windows path with no arguments. The daemon's one `serve`
/// must be the only argument — a doubled `serve` is what a parser that treats
/// `.exe` specially would produce.
#[test]
fn a_windows_bridge_exe_gets_exactly_one_serve() {
    let (program, args) = serve_argv(r"C:\tools\cante\cante-bridge.exe");
    assert_eq!(program, r"C:\tools\cante\cante-bridge.exe");
    assert_eq!(args, ["serve"]);
}

/// The same spec has to answer the two helper subcommands: `health` needs a
/// version the moment the app starts, and `catalog` is the provider list.
#[test]
fn a_windows_bridge_exe_can_be_probed() {
    let (program, args) = helper_argv(r"C:\tools\cante\cante-bridge.exe", &["--version"]);
    assert_eq!(program, r"C:\tools\cante\cante-bridge.exe");
    assert_eq!(args, ["--version"]);
    let (program, args) = helper_argv(r"C:\tools\cante\cante-bridge.exe", &["catalog"]);
    assert_eq!(program, r"C:\tools\cante\cante-bridge.exe");
    assert_eq!(args, ["catalog"]);
}

/// Windows paths may contain spaces, so the spec will often be quoted. The
/// token must survive as one argument and still gain exactly one `serve`.
#[test]
fn a_quoted_windows_bridge_path_with_spaces_stays_one_token() {
    let spec = r#""C:\Program Files\Cante\cante-bridge.exe""#;
    let (program, args) = serve_argv(spec);
    assert_eq!(program, r"C:\Program Files\Cante\cante-bridge.exe");
    assert_eq!(args, ["serve"]);
    let (program, args) = helper_argv(spec, &["--version"]);
    assert_eq!(program, r"C:\Program Files\Cante\cante-bridge.exe");
    assert_eq!(args, ["--version"]);
}

/// Someone who copies the `serve` from the WSL example onto the Windows spec
/// must not end up with `cante-bridge.exe serve serve`.
#[test]
fn a_windows_bridge_spec_that_names_serve_is_not_doubled() {
    let (program, args) = serve_argv(r"C:\tools\cante\cante-bridge.exe serve");
    assert_eq!(program, r"C:\tools\cante\cante-bridge.exe");
    assert_eq!(args, ["serve"]);
    let (_, args) = helper_argv(r"C:\tools\cante\cante-bridge.exe serve", &["--version"]);
    assert_eq!(args, ["--version"]);
}

// ---------------------------------------------------------------------------
// The spawned child, for real
// ---------------------------------------------------------------------------

/// A stand-in daemon used by the two tests below.
///
/// Started as `bun <script> serve` it echoes its own argv as its first event,
/// so a test can see exactly what the child was started with. Asked for
/// `--version` **as its first argument** it answers like the real binary — and
/// deliberately not when `--version` arrives after `serve`, which is what a
/// wrong order would look like.
const STAND_IN_SCRIPT: &str = r#"
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("stand-in 1.2.3");
  process.exit(0);
}
console.log(JSON.stringify({ timestamp: "t", id: "e1", event: { AgentMessage: args.join("|") }, parent: null }));
for await (const _chunk of process.stdin) {}
"#;

struct Events(mpsc::Sender<Value>);

impl Emitter for Events {
    fn event(&self, event: &Value) {
        let _ = self.0.send(event.clone());
    }
    fn state(&self, _state: &Value) {}
    fn log(&self, _stream: &str, _line: &str) {}
    fn exit(&self, _code: Option<i32>) {}
}

/// Write the stand-in and build a daemon whose spec names `serve` itself — the
/// spec AGENTS.md §6 tells a Windows user to write. `name` keeps the two tests
/// off each other's files (they run in parallel in one process).
fn daemon_naming_serve(name: &str) -> (Daemon, mpsc::Receiver<Value>, std::path::PathBuf) {
    let dir = std::env::temp_dir();
    let script = dir.join(format!("cante-binary-spec-{name}-{}.mjs", std::process::id()));
    std::fs::write(&script, STAND_IN_SCRIPT).expect("write stand-in script");
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());
    let spec = format!("\"{bun}\" \"{}\" serve", script.display());
    let (tx, rx) = mpsc::channel();
    let daemon = Daemon::with_config(Arc::new(Events(tx)), dir, Some(spec));
    (daemon, rx, script)
}

/// The string-level tests above say what the argv should be; this one asks the
/// real code path — `Daemon` spawning a child — so "did not double the
/// subcommand" cannot regress behind a passing unit test.
#[test]
fn a_spec_that_names_serve_spawns_one_child_with_one_subcommand() {
    let (daemon, rx, script) = daemon_naming_serve("argv");
    let _ = daemon.start_session(StartSessionArgs::default());

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen: Option<String> = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(frame) => {
                if let Some(text) = frame.pointer("/event/AgentMessage").and_then(Value::as_str) {
                    seen = Some(text.to_string());
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    assert_eq!(seen.as_deref(), Some("serve"), "the child must see exactly one serve");

    let _ = daemon.shutdown();
    let _ = std::fs::remove_file(&script);
}

/// `health` needs the version, and that probe has to reach the binary *in front
/// of* its subcommand: `ante serve --version` would not answer, and the app
/// would then say the engine is not installed.
#[test]
fn health_probes_the_version_in_front_of_the_specs_serve() {
    let (daemon, _rx, script) = daemon_naming_serve("version");
    let health = daemon.health();
    assert_eq!(
        health.pointer("/cante").and_then(Value::as_str),
        Some("stand-in 1.2.3"),
        "the version probe must run before the subcommand: {health}"
    );
    let _ = std::fs::remove_file(&script);
}
