//! End-to-end: drive the real `Daemon` against the scripted `cante serve`
//! double (`gui/fixtures/fake-cante.ts`) over real pipes.
//!
//! The fixture is a bun script, so the test points `CANTE_BIN` at
//! `"bun <script>"` (the override the contract promises) and relies on `bun`
//! being on `PATH` — the same form a Windows host needs, where a `#!` script
//! cannot be executed directly.

use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{Daemon, Emitter};

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

/// Temporarily make a file executable, restoring the original mode on drop.
#[test]
fn fake_cante_reaches_awaiting_with_a_pending_approval() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/fake-cante.ts");
    assert!(fixture.exists(), "fixture missing: {}", fixture.display());
    // Drive the fixture through `bun <script>` on every platform: Windows has no
    // shebang handling, so a direct path would only work on unix. This also
    // exercises `CANTE_BIN`'s command-spec form (see tests/binary_spec.rs).
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());
    std::env::set_var("CANTE_BIN", format!("{bun} {}", fixture.display()));

    let (tx, rx) = mpsc::channel();
    let daemon = Daemon::new(Arc::new(ChannelEmitter { tx }));

    daemon
        .start_session(Default::default())
        .expect("StartSession should be written to the daemon");
    daemon
        .send_input("hello", "prompt")
        .expect("UserInput should be written to the daemon");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut agent_message = false;
    let mut tool_start = false;
    let mut turn_pause = false;
    let mut awaiting: Option<Value> = None;

    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Wire::Event(message)) => {
                let event = &message["event"];
                if event.get("AgentMessage").and_then(Value::as_str) == Some("hello world") {
                    agent_message = true;
                }
                if event.pointer("/ToolStart/name").and_then(Value::as_str) == Some("Bash") {
                    tool_start = true;
                }
                if event.get("TurnPause").is_some() {
                    turn_pause = true;
                }
            }
            Ok(Wire::State(state)) => {
                if state.get("status").and_then(Value::as_str) == Some("awaiting") {
                    awaiting = Some(state);
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if agent_message && tool_start && turn_pause && awaiting.is_some() {
            break;
        }
    }

    assert!(agent_message, "AgentMessage(\"hello world\") should arrive");
    assert!(tool_start, "ToolStart for Bash should arrive");
    assert!(turn_pause, "TurnPause should arrive");

    let awaiting = awaiting.expect("state should reach `awaiting`");
    let pending = &awaiting["pending_approval"];
    assert_eq!(pending["turn_id"], "turn_1");
    assert_eq!(pending["message"], "Allow?");
    assert_eq!(pending["tools"][0]["id"], "tool_1");
    assert_eq!(pending["tools"][0]["name"], "Bash");

    daemon.shutdown().expect("shutdown should not error");

    // The reader thread reports the exit after the child reaps.
    let exit_deadline = Instant::now() + Duration::from_secs(10);
    let mut exited = false;
    while Instant::now() < exit_deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Exit(code)) => {
                assert_eq!(code, Some(0), "fake-cante exits cleanly");
                exited = true;
                break;
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(exited, "the daemon should emit cante://exit");
}
