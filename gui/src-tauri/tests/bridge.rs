//! End-to-end: drive `cante-bridge` (the `pi --mode rpc` adapter) against a real
//! `pi` child and a fake OpenAI-compatible endpoint, and assert what the adapter
//! promises:
//!
//! * `StartSession` produces a `SessionStart`;
//! * `UserInput` produces ordered `MessageDelta`s, an `AgentMessage` and a
//!   closing `TurnEnd`;
//! * `Interrupt` produces a `TurnEnd` whose status is "aborted", not "done";
//! * the approval gate (gui/docs/BRIDGE-gate.md): a `tool_call` is paused as
//!   `TurnPause`, a `Deny` really stops the command, one batch is one pause,
//!   per-call decisions work, and `Interrupt` works while paused.
//!
//! The gate tests rely on marker files written by the scripted `bash` command:
//! "did the command run?" is a filesystem fact, not an event to be trusted.
//!
//! The endpoint is a few dozen lines of `std::net` in this file on purpose: CI
//! installs `bun` but not `node`, so the probe's `node` fake
//! (`gui/probes/rpc/fake-openai.mjs`) cannot be reused there. No new crates.
//!
//! **`pi` is not installed on CI.** When the binary is missing the tests print
//! a `SKIP` line and return instead of failing, because an environment gap must
//! not be reported as a pass or as a product failure.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use cante_gui_lib::daemon::{helper_argv, serve_argv, Daemon, Emitter, StartSessionArgs};

/// Every wait in these tests is bounded; a stalled child must fail the test,
/// never hang the suite (AGENTS.md §5).
const WAIT: Duration = Duration::from_secs(60);

static COUNTER: AtomicU32 = AtomicU32::new(0);

// ---------------------------------------------------------------------------
// Temp directory (same shape as the other integration tests)
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|delta| delta.as_nanos())
            .unwrap_or(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("cante-bridge-{label}-{stamp}-{serial}"));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

/// `tool`: text + one bash tool call, then closing text after the tool result.
/// `slow`: a long drip of text, so the test can abort mid-stream.
struct FakeModel {
    url: String,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeModel {
    fn start(scenario: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake endpoint");
        listener.set_nonblocking(true).expect("nonblocking listener");
        let port = listener.local_addr().expect("local addr").port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !stop_thread.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = serve_connection(stream, scenario);
                    }
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self { url: format!("http://127.0.0.1:{port}/v1"), stop, handle: Some(handle) }
    }
}

impl Drop for FakeModel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve_connection(stream: TcpStream, scenario: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
        let lowered = header.to_ascii_lowercase();
        if let Some(value) = lowered.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    if method == "GET" && path == "/v1/models" {
        let payload = json!({ "object": "list", "data": [{ "id": "probe-model", "object": "model" }] })
            .to_string();
        write!(
            writer,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            payload.len(),
            payload
        )?;
        return Ok(());
    }
    if method != "POST" || path != "/v1/chat/completions" {
        writer.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")?;
        return Ok(());
    }

    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let model = request.get("model").and_then(Value::as_str).unwrap_or("probe-model").to_string();
    // A continuation is a request whose LAST message is a tool result. Keying on
    // "any tool message" would make a later prompt (which still carries the
    // earlier result in its history) look like a continuation and never call a
    // tool again.
    let has_tool_result = request
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.last())
        .map(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .unwrap_or(false);

    begin_sse(&mut writer)?;
    match scenario {
        "slow" => {
            for part in ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"] {
                let frame = chunk(&model, json!({ "role": "assistant", "content": part }), Value::Null);
                write_chunk(&mut writer, &frame)?;
                thread::sleep(Duration::from_millis(120));
            }
            write_chunk(&mut writer, &chunk(&model, json!({}), json!("stop")))?;
        }
        // `gate`: one bash call whose command writes a marker file, so
        // "did the command really run?" is a filesystem fact. `gate2` puts two
        // calls in the SAME assistant message, to pin the one-pause-per-batch
        // behaviour (the gate reads the siblings out of the session).
        "gate" | "gate2" if !has_tool_result => {
            let calls: Vec<(&str, &str)> = if scenario == "gate2" {
                vec![
                    ("call_gate_1", "echo one > gate-ran-1.txt"),
                    ("call_gate_2", "echo two > gate-ran-2.txt"),
                ]
            } else {
                vec![("call_gate_1", "echo one > gate-ran.txt")]
            };
            for part in ["我先看一下", "，然后用工具。"] {
                write_chunk(&mut writer, &chunk(&model, json!({ "role": "assistant", "content": part }), Value::Null))?;
                thread::sleep(Duration::from_millis(20));
            }
            for (index, (id, _)) in calls.iter().enumerate() {
                let call = json!({ "tool_calls": [{ "index": index, "id": id, "type": "function",
                    "function": { "name": "bash", "arguments": "" } }] });
                write_chunk(&mut writer, &chunk(&model, call, Value::Null))?;
            }
            for (index, (_, command)) in calls.iter().enumerate() {
                let arguments = json!({ "command": command }).to_string();
                let delta = json!({ "tool_calls": [{ "index": index, "function": { "arguments": arguments } }] });
                write_chunk(&mut writer, &chunk(&model, delta, Value::Null))?;
            }
            write_chunk(&mut writer, &chunk(&model, json!({}), json!("tool_calls")))?;
        }
        _ if !has_tool_result => {
            for part in ["我先看一下", "，然后用工具。"] {
                write_chunk(&mut writer, &chunk(&model, json!({ "role": "assistant", "content": part }), Value::Null))?;
                thread::sleep(Duration::from_millis(20));
            }
            let call = json!({ "tool_calls": [{ "index": 0, "id": "call_bridge_1", "type": "function",
                "function": { "name": "bash", "arguments": "" } }] });
            write_chunk(&mut writer, &chunk(&model, call, Value::Null))?;
            let arguments = json!({ "command": "echo bridge-tool-ran" }).to_string();
            let delta = json!({ "tool_calls": [{ "index": 0, "function": { "arguments": arguments } }] });
            write_chunk(&mut writer, &chunk(&model, delta, Value::Null))?;
            write_chunk(&mut writer, &chunk(&model, json!({}), json!("tool_calls")))?;
        }
        _ => {
            for part in ["完成", "了。"] {
                write_chunk(&mut writer, &chunk(&model, json!({ "role": "assistant", "content": part }), Value::Null))?;
                thread::sleep(Duration::from_millis(20));
            }
            let frame = json!({
                "id": "chatcmpl-bridge",
                "object": "chat.completion.chunk",
                "created": 1_700_000_000,
                "model": model,
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 },
            })
            .to_string();
            write_chunk(&mut writer, &sse(&frame))?;
        }
    }
    end_chunks(&mut writer)?;
    Ok(())
}

fn sse(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

fn chunk(model: &str, delta: Value, finish: Value) -> String {
    let payload = json!({
        "id": "chatcmpl-bridge",
        "object": "chat.completion.chunk",
        "created": 1_700_000_000,
        "model": model,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
    });
    sse(&payload.to_string())
}

fn begin_sse(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\ncache-control: no-cache\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n",
    )
}

fn write_chunk(stream: &mut TcpStream, data: &str) -> std::io::Result<()> {
    write!(stream, "{:x}\r\n", data.len())?;
    stream.write_all(data.as_bytes())?;
    stream.write_all(b"\r\n")
}

fn end_chunks(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n")
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct BridgeRun {
    child: Child,
    stdin: Option<ChildStdin>,
    events: mpsc::Receiver<Value>,
    received: Vec<Value>,
    work: PathBuf,
    _fake: FakeModel,
    _dir: TempDir,
}

impl BridgeRun {
    /// Spawn the adapter, or return `None` (with a loud `SKIP`) when `pi` is not
    /// installed on this machine.
    fn start(label: &str, scenario: &'static str) -> Option<Self> {
        let program = std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string());
        if !binary_answers(&program) {
            eprintln!("SKIP cante-bridge {label}: `{program}` is not installed (or never answered --version)");
            return None;
        }
        let dir = TempDir::new(label);
        let fake = FakeModel::start(scenario);
        let home = dir.path().join("pi-data");
        fs::create_dir_all(&home).expect("create pi data dir");
        fs::write(home.join("models.json"), models_json(&fake.url)).expect("write models.json");
        let work = dir.path().join("work");
        fs::create_dir_all(&work).expect("create work dir");
        // On macOS /var is a symlink to /private/var; the child reports the
        // resolved path from `current_dir()`, so compare against that.
        let work = fs::canonicalize(&work).expect("canonicalize work dir");
        // Windows `canonicalize` hands back a verbatim (`\\?\`) path while the
        // child's `current_dir()` reports the plain one, so the two would never
        // match. Strip it: both describe the same directory.
        #[cfg(windows)]
        let work = PathBuf::from(work.to_string_lossy().trim_start_matches(r"\\?\"));

        let mut child = Command::new(env!("CARGO_BIN_EXE_cante-bridge"))
            .arg("serve")
            .current_dir(&work)
            .env("PI_BIN", program)
            .env("PI_CODING_AGENT_DIR", &home)
            .env("PI_OFFLINE", "1")
            .env("PI_SKIP_VERSION_CHECK", "1")
            .env("PI_TELEMETRY", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit stderr so a broken pi or adapter shows up in the test log.
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn cante-bridge");
        let stdin = child.stdin.take().expect("bridge stdin");
        let stdout = child.stdout.take().expect("bridge stdout");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                    if tx.send(frame).is_err() {
                        break;
                    }
                }
            }
        });
        Some(Self { child, stdin: Some(stdin), events: rx, received: Vec::new(), work, _fake: fake, _dir: dir })
    }

    fn send(&mut self, op: Value, id: &str) {
        let frame = json!({ "op": op, "id": id });
        let stdin = self.stdin.as_mut().expect("bridge stdin");
        writeln!(stdin, "{frame}").expect("write op");
        stdin.flush().expect("flush op");
    }

    fn wait_for(&mut self, label: &str, hit: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                panic!("timed out waiting for {label}; saw {:?}", self.names());
            }
            match self.events.recv_timeout(remaining) {
                Ok(frame) => {
                    let matched = hit(&frame);
                    self.received.push(frame.clone());
                    if matched {
                        return frame;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for {label}; saw {:?}", self.names());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("cante-bridge exited while waiting for {label}; saw {:?}", self.names());
                }
            }
        }
    }

    fn names(&self) -> Vec<String> {
        self.received.iter().map(event_name).collect()
    }

    fn deltas(&self) -> String {
        self.received
            .iter()
            .filter_map(|frame| frame["event"]["MessageDelta"].as_str())
            .collect()
    }

    fn turn_ends(&self) -> Vec<Value> {
        self.received
            .iter()
            .filter_map(|frame| frame["event"].get("TurnEnd").cloned())
            .collect()
    }

    /// Index of the first received frame with this `Evt` name, if any.
    fn index_of(&self, name: &str) -> Option<usize> {
        self.received.iter().position(|frame| event_name(frame) == name)
    }

    fn events_named(&self, name: &str) -> Vec<&Value> {
        self.received.iter().filter(|frame| event_name(frame) == name).collect()
    }
}

impl Drop for BridgeRun {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The `Evt` variant name of a forwarded frame (unit variants are strings).
fn event_name(frame: &Value) -> String {
    match frame.get("event") {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Object(map)) => map.keys().next().cloned().unwrap_or_default(),
        _ => "<none>".to_string(),
    }
}

fn is(name: &str) -> impl Fn(&Value) -> bool + '_ {
    move |frame| event_name(frame) == name
}

/// Open a session and send one prompt. Every gate test starts the same way.
fn begin(run: &mut BridgeRun) {
    run.send(
        json!({ "StartSession": { "provider": "probe", "model": "probe-model", "permission_mode": "auto" } }),
        "op_start",
    );
    run.wait_for("SessionStart", is("SessionStart"));
    run.send(json!({ "UserInput": "把这件事做了" }), "op_input");
}

fn decision(tool_use_id: &str, decision: &str) -> Value {
    json!({ "tool_use_id": tool_use_id, "decision": decision })
}

fn approve(run: &mut BridgeRun, turn_id: &str, responses: Value) {
    run.send(
        json!({ "ApprovalResponse": { "turn_id": turn_id, "responses": responses } }),
        "op_approve",
    );
}

/// The tools a `TurnPause` is asking about, in order.
fn paused_tools(pause: &Value) -> Vec<Value> {
    pause["event"]["TurnPause"]["reason"]["Approval"]["tools"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn paused_turn_id(pause: &Value) -> String {
    pause["event"]["TurnPause"]["turn_id"].as_str().unwrap_or("").to_string()
}

/// Is this program on PATH and does it answer `--version`? Bounded, so a wedged
/// binary cannot hang the suite.
fn binary_answers(program: &str) -> bool {
    let mut child = match Command::new(program)
        .arg("--version")
        .env("PI_SKIP_VERSION_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn models_json(base_url: &str) -> String {
    json!({
        "providers": {
            "probe": {
                "baseUrl": base_url,
                "api": "openai-completions",
                "apiKey": "bridge-test-key",
                "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
                "models": [{
                    "id": "probe-model",
                    "name": "Probe Model",
                    "reasoning": false,
                    "input": ["text"],
                    "contextWindow": 32000,
                    "maxTokens": 4096,
                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
                }],
            }
        }
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// `daemon.rs` probes `CANTE_BIN` out of process before it ever spawns `serve`:
/// `helper_argv(spec, ["--version"])` feeds the wizard's "is the engine
/// installed" check, and `serve_argv(spec)` is how the long-running child is
/// started. Both must reach this binary's subcommands, and the version line
/// must be non-empty. This test needs no `pi`, so it also runs on CI.
#[test]
fn bridge_answers_the_daemon_probe_subcommands() {
    let bin = env!("CARGO_BIN_EXE_cante-bridge");

    let (_, args) = helper_argv("cante-bridge", &["--version"]);
    let (stdout, stderr) = run_bounded(bin, &args, Duration::from_secs(30));
    let version = stdout.trim();
    assert!(version.starts_with("cante-bridge"), "version line was {version:?} ({stderr})");

    let (_, args) = helper_argv("cante-bridge", &["catalog"]);
    let (stdout, _) = run_bounded(bin, &args, Duration::from_secs(30));
    let catalog: Value = serde_json::from_str(stdout.trim()).expect("catalog must be JSON");
    assert_eq!(catalog["providers"], json!([]));

    // The daemon owns the `serve` suffix; the bridge must accept exactly that.
    let (program, args) = serve_argv("cante-bridge");
    assert_eq!(program, "cante-bridge");
    assert_eq!(args, vec!["serve".to_string()]);
}

/// The events `daemon.rs` advertises, captured for assertions.
enum Wire {
    Event(Value),
    #[allow(dead_code)]
    State(Value),
    #[allow(dead_code)]
    Log(String, String),
    #[allow(dead_code)]
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

/// The point of the whole adapter: `CANTE_BIN` points at `cante-bridge`, and
/// the existing `Daemon` — the exact code the Tauri commands call — drives it
/// without a single change. This is the production path (minus the webview),
/// so it is the guard against "tested a path the product never takes".
#[test]
fn the_rust_daemon_drives_the_adapter_without_changes() {
    let program = std::env::var("PI_BIN").unwrap_or_else(|_| "pi".to_string());
    if !binary_answers(&program) {
        eprintln!("SKIP cante-bridge daemon path: `{program}` is not installed");
        return;
    }
    let dir = TempDir::new("daemon");
    let fake = FakeModel::start("tool");
    let home = dir.path().join("pi-data");
    fs::create_dir_all(&home).expect("create pi data dir");
    fs::write(home.join("models.json"), models_json(&fake.url)).expect("write models.json");
    // The bridge child inherits these; the daemon does not interpret them.
    std::env::set_var("PI_CODING_AGENT_DIR", &home);
    std::env::set_var("PI_OFFLINE", "1");
    std::env::set_var("PI_SKIP_VERSION_CHECK", "1");
    std::env::set_var("PI_TELEMETRY", "0");

    let (tx, rx) = mpsc::channel();
    // Quoted so a Windows path with spaces survives `serve_argv`'s split.
    let spec = format!("\"{}\"", env!("CARGO_BIN_EXE_cante-bridge"));
    let daemon = Daemon::with_config(
        Arc::new(ChannelEmitter { tx }),
        dir.path().to_path_buf(),
        Some(spec),
    );
    daemon
        .start_session(StartSessionArgs {
            provider: Some("probe".to_string()),
            model: Some("probe-model".to_string()),
            permission_mode: Some("auto".to_string()),
            ..Default::default()
        })
        .expect("StartSession must reach the adapter");
    daemon.send_input("把这件事做了", "prompt").expect("UserInput must reach the adapter");

    let deadline = Instant::now() + WAIT;
    let mut session_start = false;
    let mut deltas = String::new();
    let mut completed = false;
    while Instant::now() < deadline && !(session_start && completed) {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Event(frame)) => {
                if let Some(text) = frame["event"]["MessageDelta"].as_str() {
                    deltas.push_str(text);
                }
                match event_name(&frame).as_str() {
                    "SessionStart" => session_start = true,
                    "TurnPause" => {
                        // The production path pauses for approval like any other
                        // client; answering through `Daemon::approve` is the
                        // exact call the Tauri command makes.
                        let turn_id = frame["event"]["TurnPause"]["turn_id"].as_str().unwrap_or("");
                        let responses: Vec<Value> = paused_tools(&frame)
                            .iter()
                            .map(|tool| decision(tool["id"].as_str().unwrap_or(""), "Accept"))
                            .collect();
                        daemon.approve(turn_id, responses).expect("the daemon must be able to approve");
                    }
                    "TurnEnd" if frame["event"]["TurnEnd"]["status"] == json!("Completed") => {
                        completed = true;
                    }
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(session_start, "the daemon must have seen a SessionStart");
    assert!(completed, "the daemon must have seen a completed TurnEnd; deltas={deltas:?}");
    assert_eq!(deltas, "我先看一下，然后用工具。完成了。");
}

/// An assistant that exits before the session opens must be reported, not
/// swallowed: `StartSession` has to answer with an `Error`. A misconfigured
/// provider looks exactly like this, and "nothing happened" is the failure mode
/// product law 3 forbids. Needs no `pi`, so it also runs on CI.
#[cfg(unix)]
#[test]
fn bridge_reports_an_assistant_that_dies_at_startup() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new("dead-pi");
    let script = dir.path().join("dead-pi.sh");
    fs::write(&script, "#!/bin/sh\nexit 0\n").expect("write script");
    let mut permissions = fs::metadata(&script).expect("stat script").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).expect("chmod script");

    let mut child = Command::new(env!("CARGO_BIN_EXE_cante-bridge"))
        .arg("serve")
        .current_dir(dir.path())
        .env("PI_BIN", &script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn cante-bridge");
    let mut stdin = child.stdin.take().expect("bridge stdin");
    let stdout = child.stdout.take().expect("bridge stdout");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if tx.send(frame).is_err() {
                    break;
                }
            }
        }
    });
    writeln!(stdin, "{}", json!({ "op": { "StartSession": {} }, "id": "op_start" })).expect("write op");
    stdin.flush().expect("flush op");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut saw_error = false;
    while Instant::now() < deadline && !saw_error {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(frame) => {
                if event_name(&frame) == "Error" {
                    saw_error = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    assert!(saw_error, "an assistant that exits at startup must produce an Error event");
}

fn run_bounded(program: &str, args: &[String], timeout: Duration) -> (String, String) {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn cante-bridge");
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }
    let output = child.wait_with_output().expect("wait for cante-bridge");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

#[test]
fn bridge_streams_a_turn_from_pi() {
    let Some(mut run) = BridgeRun::start("stream", "tool") else {
        return;
    };
    run.send(
        json!({ "StartSession": { "provider": "probe", "model": "probe-model", "permission_mode": "auto" } }),
        "op_start",
    );
    let session = run.wait_for("SessionStart", is("SessionStart"));
    let info = &session["event"]["SessionStart"];
    assert_eq!(info["model"]["id"], json!("probe-model"), "SessionStart.model.id");
    assert_eq!(info["model"]["display_name"], json!("Probe Model"), "SessionStart.model.display_name");
    assert_eq!(info["model"]["support_vision"], json!(false), "text-only model must not claim vision");
    assert_eq!(info["provider"]["id"], json!("probe"), "SessionStart.provider.id");
    assert_eq!(info["permission_mode"], json!("Auto"), "SessionStart.permission_mode");
    assert_eq!(info["cwd"], json!(run.work.to_string_lossy()), "SessionStart.cwd");
    assert_eq!(info["skills"], json!([]));
    assert!(
        !info["session_id"].as_str().unwrap_or("").is_empty(),
        "pi must report a session id: {info}"
    );

    run.send(json!({ "UserInput": "把这件事做了" }), "op_input");
    let turn_start = run.wait_for("TurnStart", is("TurnStart"));
    let turn_id = turn_start["event"]["TurnStart"]["turn_id"].clone();
    assert!(turn_id.as_str().unwrap_or("").starts_with("turn_"));

    // The gate stops the call before it runs; this test only needs it to go
    // through, so it allows once.
    let pause = run.wait_for("TurnPause", is("TurnPause"));
    approve(&mut run, &paused_turn_id(&pause), json!([decision("call_bridge_1", "Accept")]));

    let tool_start = run.wait_for("ToolStart", is("ToolStart"));
    assert_eq!(tool_start["event"]["ToolStart"]["name"], json!("bash"));
    let tool_end = run.wait_for("ToolEnd", is("ToolEnd"));
    assert_eq!(tool_end["event"]["ToolEnd"]["status"], json!("Completed"));

    let final_message = run.wait_for("the closing AgentMessage", |frame| {
        event_name(frame) == "AgentMessage" && frame["event"]["AgentMessage"].as_str() == Some("完成了。")
    });
    assert_eq!(final_message["event"]["AgentMessage"], json!("完成了。"));

    let end = run.wait_for("TurnEnd", is("TurnEnd"));
    assert_eq!(end["event"]["TurnEnd"]["status"], json!("Completed"));
    assert_eq!(end["event"]["TurnEnd"]["turn_id"], turn_id);
    assert!(
        end["event"]["TurnEnd"]["steps"].as_u64().unwrap_or(0) >= 2,
        "a tool-calling prompt is at least two assistant replies: {end}"
    );

    // The deltas must arrive in the order the model produced them, and the
    // adapter must echo the prompt as `UserInput` (the transcript's "you" row).
    assert_eq!(run.deltas(), "我先看一下，然后用工具。完成了。");
    assert!(run.received.iter().any(is("UserInput")), "the prompt must be echoed as UserInput");
    assert_eq!(run.turn_ends().len(), 1, "exactly one TurnEnd per user turn");

    // Usage: the fake endpoint only reports tokens on the closing chunk, so the
    // tool-call reply's all-zero report must produce nothing while the final
    // response produces exactly one update that matches what was sent.
    let updates = run.events_named("UsageUpdate");
    assert_eq!(updates.len(), 1, "only the accounted response may report usage: {:?}", run.names());
    let usage = &updates[0]["event"]["UsageUpdate"];
    assert_eq!(usage["usage"]["input_tokens"], json!(100), "the endpoint reported 100 prompt tokens");
    assert_eq!(usage["usage"]["output_tokens"], json!(20));
    assert_eq!(usage["usage"]["cache_read_tokens"], json!(0));
    assert_eq!(usage["usage"]["cache_creation_tokens"], json!(0));
    assert_eq!(usage["context"]["used_tokens"], json!(120));
    assert_eq!(usage["context"]["limit_tokens"], json!(32000), "the window comes from get_state");
    assert!(
        run.index_of("UsageUpdate").unwrap() < run.index_of("TurnEnd").unwrap(),
        "usage belongs to the response, so it lands before the turn closes"
    );
}

#[test]
fn bridge_reports_an_interrupted_turn() {
    let Some(mut run) = BridgeRun::start("abort", "slow") else {
        return;
    };
    run.send(
        json!({ "StartSession": { "provider": "probe", "model": "probe-model", "permission_mode": "auto" } }),
        "op_start",
    );
    run.wait_for("SessionStart", is("SessionStart"));
    run.send(json!({ "UserInput": "慢慢来" }), "op_input");
    run.wait_for("the first MessageDelta", is("MessageDelta"));
    run.send(json!("Interrupt"), "op_stop");

    let end = run.wait_for("TurnEnd", is("TurnEnd"));
    let status = &end["event"]["TurnEnd"]["status"];
    assert!(
        status.get("Interrupted").is_some(),
        "an aborted turn must be reported as interrupted, got: {status}"
    );
    for turn_end in run.turn_ends() {
        assert_ne!(turn_end["status"], json!("Completed"), "a stopped turn must never read as done");
    }
}

// ---------------------------------------------------------------------------
// The approval gate (gui/docs/BRIDGE-gate.md)
// ---------------------------------------------------------------------------

/// The core promise: a tool call is stopped *before* it runs, the window gets a
/// `TurnPause` whose `tool_use_id` is the real `toolCallId`, and a `Deny` means
/// the command never executed — asserted on the filesystem, not on an event.
#[test]
fn bridge_pauses_a_call_and_a_denial_stops_it() {
    let Some(mut run) = BridgeRun::start("gate-deny", "gate") else {
        return;
    };
    begin(&mut run);
    let turn_id = run.wait_for("TurnStart", is("TurnStart"))["event"]["TurnStart"]["turn_id"].clone();

    let pause = run.wait_for("TurnPause", is("TurnPause"));
    assert_eq!(pause["event"]["TurnPause"]["turn_id"], turn_id, "the pause belongs to the open turn");
    let tools = paused_tools(&pause);
    assert_eq!(tools.len(), 1, "one call, one question: {pause}");
    assert_eq!(tools[0]["id"], json!("call_gate_1"), "tool_use_id must be pi's toolCallId");
    assert_eq!(tools[0]["name"], json!("bash"));
    assert_eq!(tools[0]["args"]["command"], json!("echo one > gate-ran.txt"));
    // Probe revision B: the progress list must not say "running" while the
    // approval sheet is still open.
    assert!(run.index_of("ToolStart").is_none(), "no ToolStart before the decision");

    approve(&mut run, &paused_turn_id(&pause), json!([decision("call_gate_1", "Deny")]));

    let resume = run.wait_for("TurnResume", is("TurnResume"));
    assert_eq!(resume["event"]["TurnResume"]["turn_id"], turn_id);
    run.wait_for("the denied call's ToolStart", is("ToolStart"));
    let tool_end = run.wait_for("ToolEnd", is("ToolEnd"));
    assert_eq!(tool_end["event"]["ToolEnd"]["status"], json!("Denied"));
    // The row opens (with the sheet already closed) and closes as denied: the
    // frontend builds its tool row from `ToolStart`, and colours it from the
    // `ToolEnd` status.
    assert_eq!(
        run.index_of("ToolStart").unwrap(),
        run.index_of("TurnResume").unwrap() + 1,
        "the row opens after the sheet closes"
    );
    assert!(
        run.index_of("ToolEnd").unwrap() > run.index_of("ToolStart").unwrap(),
        "the row must open before it closes"
    );

    let end = run.wait_for("TurnEnd", is("TurnEnd"));
    assert_eq!(end["event"]["TurnEnd"]["status"], json!("Completed"), "the assistant carries on after a denial");
    assert_eq!(run.events_named("ToolEnd").len(), 1, "a denied call closes exactly once");
    assert!(!run.work.join("gate-ran.txt").exists(), "a denied command must not run");
}

/// Accepting really runs the command.
#[test]
fn bridge_runs_an_accepted_call() {
    let Some(mut run) = BridgeRun::start("gate-accept", "gate") else {
        return;
    };
    begin(&mut run);
    run.wait_for("TurnStart", is("TurnStart"));
    let pause = run.wait_for("TurnPause", is("TurnPause"));
    approve(&mut run, &paused_turn_id(&pause), json!([decision("call_gate_1", "Accept")]));

    let ends = run.wait_for("ToolEnd", is("ToolEnd"));
    assert_eq!(ends["event"]["ToolEnd"]["status"], json!("Completed"));
    let end = run.wait_for("TurnEnd", is("TurnEnd"));
    assert_eq!(end["event"]["TurnEnd"]["status"], json!("Completed"));
    assert!(run.work.join("gate-ran.txt").exists(), "an accepted command must run");
}

/// Two calls in one assistant message produce **one** `TurnPause` carrying both
/// (PROBE §3 revision D: read the siblings out of `ctx.sessionManager`).
#[test]
fn bridge_asks_once_for_a_batch_of_calls() {
    let Some(mut run) = BridgeRun::start("gate-batch", "gate2") else {
        return;
    };
    begin(&mut run);
    run.wait_for("TurnStart", is("TurnStart"));
    let pause = run.wait_for("TurnPause", is("TurnPause"));
    let tools = paused_tools(&pause);
    let mut ids: Vec<&str> = tools.iter().filter_map(|tool| tool["id"].as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec!["call_gate_1", "call_gate_2"], "both siblings must ride one pause: {pause}");

    approve(
        &mut run,
        &paused_turn_id(&pause),
        json!([decision("call_gate_1", "Accept"), decision("call_gate_2", "Accept")]),
    );
    run.wait_for("TurnEnd", is("TurnEnd"));

    assert_eq!(run.events_named("TurnPause").len(), 1, "the batch must not be asked call by call");
    assert!(run.work.join("gate-ran-1.txt").exists());
    assert!(run.work.join("gate-ran-2.txt").exists());
}

/// Per-call decisions do come back: one sibling allowed, the other denied. This
/// is the question `PROBE-pi-rpc.md` §6 left open for a single-valued dialog —
/// answered here with the adapter's own encoding (see BRIDGE-gate.md).
#[test]
fn bridge_can_allow_one_call_and_deny_its_sibling() {
    let Some(mut run) = BridgeRun::start("gate-partial", "gate2") else {
        return;
    };
    begin(&mut run);
    run.wait_for("TurnStart", is("TurnStart"));
    let pause = run.wait_for("TurnPause", is("TurnPause"));
    approve(
        &mut run,
        &paused_turn_id(&pause),
        json!([decision("call_gate_1", "Accept"), decision("call_gate_2", "Deny")]),
    );
    run.wait_for("TurnEnd", is("TurnEnd"));

    let statuses: Vec<String> = run
        .events_named("ToolEnd")
        .iter()
        .filter_map(|frame| frame["event"]["ToolEnd"]["status"].as_str().map(str::to_string))
        .collect();
    assert!(statuses.contains(&"Completed".to_string()), "the allowed call ran: {statuses:?}");
    assert!(statuses.contains(&"Denied".to_string()), "the denied call was blocked: {statuses:?}");
    assert!(run.work.join("gate-ran-1.txt").exists());
    assert!(!run.work.join("gate-ran-2.txt").exists());
}

/// Stop must work while the sheet is open, not only during streaming.
#[test]
fn bridge_can_interrupt_while_waiting_for_approval() {
    let Some(mut run) = BridgeRun::start("gate-interrupt", "gate") else {
        return;
    };
    begin(&mut run);
    run.wait_for("TurnStart", is("TurnStart"));
    run.wait_for("TurnPause", is("TurnPause"));
    run.send(json!("Interrupt"), "op_stop");

    let end = run.wait_for("TurnEnd", is("TurnEnd"));
    let status = &end["event"]["TurnEnd"]["status"];
    assert!(status.get("Interrupted").is_some(), "stopping at the sheet must be an interrupt, got {status}");
    assert!(!run.work.join("gate-ran.txt").exists(), "nothing may run after a stop");
    assert!(run.turn_ends().iter().all(|turn| turn["status"] != json!("Completed")));
}

/// `AcceptAlways` is remembered for the rest of this bridge process (by tool
/// name) — and that is all: see BRIDGE-gate.md §4 for why it is not persisted.
#[test]
fn bridge_remembers_allow_always_for_the_session() {
    let Some(mut run) = BridgeRun::start("gate-always", "gate") else {
        return;
    };
    begin(&mut run);
    run.wait_for("TurnStart", is("TurnStart"));
    let pause = run.wait_for("TurnPause", is("TurnPause"));
    approve(&mut run, &paused_turn_id(&pause), json!([decision("call_gate_1", "AcceptAlways")]));
    run.wait_for("TurnEnd", is("TurnEnd"));
    let marker = run.work.join("gate-ran.txt");
    assert!(marker.exists(), "the allowed call must have run");

    // Second turn, same tool name: the question must not come back.
    fs::remove_file(&marker).expect("remove the marker for the second turn");
    run.send(json!({ "UserInput": "再来一次" }), "op_input_2");
    run.wait_for("the second TurnStart", is("TurnStart"));
    run.wait_for("the second TurnEnd", is("TurnEnd"));
    assert_eq!(run.turn_ends().len(), 2, "the second turn must have ended");
    assert_eq!(run.events_named("TurnPause").len(), 1, "an already-allowed tool must not be asked again");
    assert!(marker.exists(), "the second call must have run without a pause");
}
