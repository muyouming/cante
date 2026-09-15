//! End-to-end: drive the real `Daemon` against the scripted `cante serve`
//! double (`gui/fixtures/fake-cante.ts`) over real pipes.
//!
//! The fixture is a bun script, so the test sets `CANTE_BIN` to its path (the
//! override the contract promises) and relies on `bun` being on `PATH`. The
//! ported fixture does not carry the executable bit in git, so it is granted
//! for the duration of the test and restored afterwards.

use std::path::{Path, PathBuf};
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
#[cfg(unix)]
struct ExecutableGuard {
    path: PathBuf,
    mode: u32,
}

#[cfg(unix)]
impl ExecutableGuard {
    fn ensure(path: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(path)?;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 {
            let mut permissions = metadata.permissions();
            permissions.set_mode(mode | 0o755);
            std::fs::set_permissions(path, permissions)?;
        }
        Ok(Self { path: path.to_path_buf(), mode })
    }
}

#[cfg(unix)]
impl Drop for ExecutableGuard {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(&self.path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(self.mode);
            let _ = std::fs::set_permissions(&self.path, permissions);
        }
    }
}

#[test]
fn fake_cante_reaches_awaiting_with_a_pending_approval() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/fake-cante.ts");
    assert!(fixture.exists(), "fixture missing: {}", fixture.display());
    #[cfg(unix)]
    let _executable = ExecutableGuard::ensure(&fixture).expect("grant fixture executable bit");
    std::env::set_var("CANTE_BIN", &fixture);

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
