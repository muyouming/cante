//! Reader-loop behaviour against real child processes.
//!
//! These drive `Daemon` over real pipes with a tiny generated script instead of
//! the shared fixture, because the point is to pin how the loop reacts to
//! malformed and truncated stdout. The script is run as `bun <script> serve`
//! (the same command-spec form `CANTE_BIN` accepts, and the only form that
//! works on Windows), and the script path is quoted so a temp directory with
//! spaces survives.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{Daemon, Emitter, StartSessionArgs};

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum Wire {
    Event(Value),
    State(Value),
    Log(String, String),
    Exit(Option<i32>),
}

struct ChannelEmitter {
    tx: mpsc::Sender<Wire>,
}

impl Emitter for ChannelEmitter {
    fn event(&self, event: &Value) {
        let _ = self.tx.send(Wire::Event(event.clone()));
    }

    fn state(&self, state: &Value) {
        let _ = self.tx.send(Wire::State(state.clone()));
    }

    fn log(&self, stream: &str, line: &str) {
        let _ = self.tx.send(Wire::Log(stream.to_string(), line.to_string()));
    }

    fn exit(&self, code: Option<i32>) {
        let _ = self.tx.send(Wire::Exit(code));
    }
}

static SCRIPT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write a one-off `cante serve` stand-in and return its path.
fn write_script(body: &str) -> PathBuf {
    let unique = SCRIPT_SEQ.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("cante-reader-{}-{unique}.mjs", std::process::id()));
    std::fs::write(&path, body).expect("write stand-in script");
    path
}

/// Spawn `bun <script> serve` through the public `with_config` bin slot. This
/// is exactly the spec `CANTE_BIN` carries, but explicit so parallel tests do
/// not race on a process-global environment variable.
fn daemon_for(script: &PathBuf) -> (Daemon, mpsc::Receiver<Wire>) {
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());
    let spec = format!("\"{bun}\" \"{}\"", script.display());
    let (tx, rx) = mpsc::channel();
    let daemon =
        Daemon::with_config(Arc::new(ChannelEmitter { tx }), std::env::temp_dir(), Some(spec));
    (daemon, rx)
}

#[test]
fn a_non_json_line_is_logged_and_reading_continues() {
    let script = write_script(
        r#"
console.log("this is definitely not json");
console.log(JSON.stringify({ timestamp: "t", id: "e1", event: { AgentMessage: "one" }, parent: null }));
console.log("   ");
console.log(JSON.stringify({ timestamp: "t", id: "e2", event: { AgentMessage: "two" }, parent: null }));
for await (const _chunk of process.stdin) {}
"#,
    );
    let (daemon, rx) = daemon_for(&script);
    // The write may race the child exiting; the reader threads still run.
    let _ = daemon.start_session(StartSessionArgs::default());

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut messages: Vec<String> = Vec::new();
    let mut bad_line_logged = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Event(frame)) => {
                if let Some(text) = frame.pointer("/event/AgentMessage").and_then(Value::as_str) {
                    messages.push(text.to_string());
                }
            }
            Ok(Wire::Log(stream, line)) => {
                if stream == "stdout" && line.contains("definitely not json") {
                    bad_line_logged = true;
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if messages.len() == 2 && bad_line_logged {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if messages.len() == 2 && bad_line_logged {
            break;
        }
    }

    assert!(bad_line_logged, "the non-JSON line must be logged, not swallowed");
    assert_eq!(
        messages,
        vec!["one".to_string(), "two".to_string()],
        "a bad line must not stop later events from arriving"
    );

    let _ = daemon.shutdown();
    let _ = std::fs::remove_file(&script);
}

#[test]
fn a_source_that_closes_mid_line_keeps_already_complete_events() {
    let script = write_script(
        r#"
process.stdout.write(JSON.stringify({ timestamp: "t", id: "e1", event: { AgentMessage: "complete" }, parent: null }) + "\n");
process.stdout.write('{"timestamp":"t","id":"e2","event":{"AgentM');
await new Promise((resolve) => setTimeout(resolve, 150));
process.exit(0);
"#,
    );
    let (daemon, rx) = daemon_for(&script);
    let _ = daemon.start_session(StartSessionArgs::default());

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut complete_event = false;
    let mut partial_logged = false;
    let mut exited = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Event(frame)) => {
                if frame.pointer("/event/AgentMessage").and_then(Value::as_str) == Some("complete")
                {
                    complete_event = true;
                }
            }
            Ok(Wire::Log(stream, line)) => {
                if stream == "stdout" && line.contains("\"AgentM") {
                    partial_logged = true;
                }
            }
            Ok(Wire::Exit(_)) => {
                exited = true;
                break;
            }
            Ok(Wire::State(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    assert!(complete_event, "the complete event framed before the cut must still arrive");
    assert!(partial_logged, "the unterminated tail is flushed once, as a skipped log line");
    assert!(exited, "EOF must finalize the daemon and emit cante://exit");

    let _ = std::fs::remove_file(&script);
}
