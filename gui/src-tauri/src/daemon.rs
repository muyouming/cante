//! `cante serve` ownership: spawn, JSONL framing, op ids, event ring, state.
//!
//! The daemon is spawned lazily on the first op-sending command. Its stdout is
//! reassembled into lines and each `EventMsg` is forwarded verbatim as a
//! `serde_json::Value`; the state machine folded here is the contract's
//! transition table.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::protocol::{self, CanteState, LineSplitter};

/// Number of recent events retained for `events_since`.
pub const RING_CAPACITY: usize = 4096;

const CATALOG_TTL: Duration = Duration::from_secs(60);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/// Sink for the four events the bridge advertises. Production wires this to a
/// Tauri `AppHandle`; tests wire it to a channel.
pub trait Emitter: Send + Sync + 'static {
    fn event(&self, event: &Value);
    fn state(&self, state: &Value);
    fn log(&self, stream: &str, line: &str);
    fn exit(&self, code: Option<i32>);
}

// ---------------------------------------------------------------------------
// Event ring
// ---------------------------------------------------------------------------

/// A bounded ring of events with a monotonic cursor.
///
/// `cursor` counts every event ever pushed. The events retained are the ones
/// with indices `[cursor - len, cursor)`.
pub struct EventRing {
    events: VecDeque<Value>,
    cursor: u64,
    capacity: usize,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self {
        Self { events: VecDeque::with_capacity(capacity.min(64)), cursor: 0, capacity: capacity.max(1) }
    }

    pub fn push(&mut self, event: Value) {
        self.events.push_back(event);
        self.cursor += 1;
        while self.events.len() > self.capacity {
            self.events.pop_front();
        }
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Cursor of the oldest retained event.
    pub fn first_cursor(&self) -> u64 {
        self.cursor - self.events.len() as u64
    }

    /// Slice `[cursor, head)` out of the ring.
    ///
    /// A cursor that fell off the front is clamped to the oldest retained
    /// event and reported as `truncated`; a cursor past the head is clamped to
    /// the head and yields nothing.
    pub fn since(&self, cursor: u64) -> (u64, bool, Vec<Value>) {
        let first = self.first_cursor();
        let (start, truncated) =
            if cursor < first { (first, true) } else { (cursor.min(self.cursor), false) };
        let offset = (start - first) as usize;
        let events = self.events.iter().skip(offset).cloned().collect();
        (self.cursor, truncated, events)
    }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
}

struct Inner {
    proc: Option<Proc>,
    ring: EventRing,
    state: CanteState,
    cante: Option<String>,
    version_checked: bool,
    cwd: PathBuf,
    bin: String,
    exit_code: Option<i32>,
    catalog: Option<(Instant, Value)>,
}

/// Owns the `cante serve` child process and the shared bridge state.
pub struct Daemon {
    inner: Arc<Mutex<Inner>>,
    emitter: Arc<dyn Emitter>,
}

impl Daemon {
    /// Build a daemon using the component this computer has: the environment
    /// variable, then a `cante`/`cante-bridge` next to the app, then
    /// `$HOME/.cante/bin`, then `cante` on `PATH`. The order lives in
    /// [`crate::program`], which the 「检查你的电脑」probe calls too — so the
    /// probe and this spawn can never disagree about what is installed.
    pub fn new(emitter: Arc<dyn Emitter>) -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        Self::with_config(emitter, cwd, None)
    }

    /// Build a daemon with an explicit working directory and optional binary.
    ///
    /// An explicit `bin` (tests, callers that already resolved it) wins; otherwise
    /// the lookup in [`crate::program::daemon_here`] decides — that is what makes
    /// 「装完就能用」true without setting anything (issue #150).
    pub fn with_config(emitter: Arc<dyn Emitter>, cwd: PathBuf, bin: Option<String>) -> Self {
        let bin = bin.unwrap_or_else(|| crate::program::daemon_here().spec().to_string());
        Self {
            inner: Arc::new(Mutex::new(Inner {
                proc: None,
                ring: EventRing::new(RING_CAPACITY),
                state: CanteState::default(),
                cante: None,
                version_checked: false,
                cwd,
                bin,
                exit_code: None,
                catalog: None,
            })),
            emitter,
        }
    }

    // -- reads ---------------------------------------------------------------

    /// `health` — bridge/cante liveness plus the current state status.
    pub fn health(&self) -> Value {
        self.ensure_version();
        let mut inner = self.inner.lock().unwrap();
        let daemon = match inner.proc.as_mut() {
            Some(proc) => matches!(proc.child.try_wait(), Ok(None)),
            None => false,
        };
        json!({
            "ok": true,
            "cante": inner.cante,
            "cwd": inner.cwd.to_string_lossy(),
            "daemon": daemon,
            "status": inner.state.status,
        })
    }

    /// `events_since` — cursor-addressed slice of the ring plus full state.
    pub fn events_since(&self, cursor: u64) -> Value {
        let inner = self.inner.lock().unwrap();
        let (head, truncated, events) = inner.ring.since(cursor);
        json!({
            "cursor": head,
            "truncated": truncated,
            "events": events,
            "state": inner.state.to_value(inner.cante.as_deref(), &inner.cwd.to_string_lossy()),
        })
    }

    fn state_payload(inner: &Inner) -> Value {
        inner.state.to_value(inner.cante.as_deref(), &inner.cwd.to_string_lossy())
    }

    // -- ops -----------------------------------------------------------------

    /// `start_session` — `StartSession`, or `ResumeSession` when a session id is pinned.
    pub fn start_session(&self, args: StartSessionArgs) -> Result<(), String> {
        self.send_op(start_session_op(args)).map(|_| ())
    }

    /// `update_session` — patch model / permission mode / title.
    pub fn update_session(
        &self,
        model: Option<Value>,
        permission_mode: Option<String>,
        title: Option<String>,
    ) -> Result<(), String> {
        self.send_op(update_session_op(model, permission_mode, title)?).map(|_| ())
    }

    /// `send_input` — a prompt, a steer, or a shell command.
    pub fn send_input(&self, text: &str, mode: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("text is required".to_string());
        }
        let op = match mode.to_ascii_lowercase().as_str() {
            "steer" => json!({ "Steer": text }),
            "shell" => json!({ "ShellInput": text }),
            _ => json!({ "UserInput": text }),
        };
        self.send_op(op).map(|_| ())
    }

    /// `steer` — inject a steering message into the running turn.
    pub fn steer(&self, text: &str) -> Result<(), String> {
        self.send_op(steer_op(text)?).map(|_| ())
    }

    /// `shell_input` — run a shell command through the daemon.
    pub fn shell_input(&self, command: &str) -> Result<(), String> {
        self.send_op(shell_input_op(command)?).map(|_| ())
    }

    /// `ambient_phrase` — ask the daemon to draft a thinking phrase.
    pub fn ambient_phrase(&self, draft: &str, request_id: u64) -> Result<(), String> {
        self.send_op(ambient_phrase_op(draft, request_id)).map(|_| ())
    }

    /// `ambient_suggestion` — ask the daemon for a prompt suggestion.
    pub fn ambient_suggestion(
        &self,
        recent_user: &str,
        recent_agent: &str,
        request_id: u64,
    ) -> Result<(), String> {
        self.send_op(ambient_suggestion_op(recent_user, recent_agent, request_id)).map(|_| ())
    }

    /// `approve` — answer a `TurnPause` approval prompt.
    pub fn approve(&self, turn_id: &str, responses: Vec<Value>) -> Result<(), String> {
        if turn_id.is_empty() || responses.is_empty() {
            return Err("turn_id and responses are required".to_string());
        }
        self.send_op(json!({ "ApprovalResponse": { "turn_id": turn_id, "responses": responses } }))
            .map(|_| ())
    }

    /// `interrupt` — abort the in-flight turn.
    pub fn interrupt(&self) -> Result<(), String> {
        self.send_op(json!("Interrupt")).map(|_| ())
    }

    /// `compact` — replace conversation history with a summary.
    pub fn compact(&self, instructions: Option<String>) -> Result<(), String> {
        let op = match instructions {
            Some(instructions) => json!({ "Compact": { "instructions": instructions } }),
            None => json!({ "Compact": {} }),
        };
        self.send_op(op).map(|_| ())
    }

    /// `context_report` — request a per-category context breakdown.
    pub fn context_report(&self) -> Result<(), String> {
        self.send_op(json!("ContextReport")).map(|_| ())
    }

    /// `slash` — run a session skill or client command on the daemon.
    pub fn slash(&self, name: &str, args: &str) -> Result<(), String> {
        self.send_op(json!({ "SlashCommand": { "name": name, "args": args } })).map(|_| ())
    }

    /// `goal` — set, clear, or report the goal-driven loop.
    pub fn goal(&self, command: &str, condition: Option<String>) -> Result<(), String> {
        let op = match command {
            "Set" => json!({ "Goal": { "Set": condition.unwrap_or_default() } }),
            "Clear" => json!({ "Goal": "Clear" }),
            _ => json!({ "Goal": "Status" }),
        };
        self.send_op(op).map(|_| ())
    }

    /// `set_cwd` — directory the daemon is spawned in (and `catalog` runs in).
    pub fn set_cwd(&self, cwd: &str) -> Result<(), String> {
        let path = PathBuf::from(cwd);
        if !path.is_dir() {
            return Err(format!("not a directory: {cwd}"));
        }
        let mut inner = self.inner.lock().unwrap();
        inner.cwd = path;
        Ok(())
    }

    /// `shutdown` — ask the daemon to close and drop its stdin.
    pub fn shutdown(&self) -> Result<(), String> {
        let running = self.inner.lock().unwrap().proc.is_some();
        if running {
            let _ = self.send_op(json!("Shutdown"));
            let mut inner = self.inner.lock().unwrap();
            if let Some(proc) = inner.proc.as_mut() {
                // Closing stdin guarantees the daemon converges even if it
                // ignores the Shutdown op.
                drop(proc.stdin.take());
            }
        }
        Ok(())
    }

    /// `catalog` — the merged provider catalog, run out-of-process.
    pub fn catalog(&self) -> Result<Value, String> {
        let (bin, cwd, cached) = {
            let inner = self.inner.lock().unwrap();
            (inner.bin.clone(), inner.cwd.clone(), inner.catalog.clone())
        };
        if let Some((at, value)) = cached {
            if at.elapsed() < CATALOG_TTL {
                return Ok(value);
            }
        }
        let (stdout, stderr) = run_capture(&bin, &["catalog"], &cwd, CAPTURE_TIMEOUT)?;
        let parsed: Value = serde_json::from_str(&stdout)
            .map_err(|error| format!("catalog output was not JSON: {error}{}", suffix(&stderr)))?;
        let providers = parsed.get("providers").cloned().unwrap_or_else(|| json!([]));
        let value = json!({ "providers": providers });
        let mut inner = self.inner.lock().unwrap();
        inner.catalog = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    // -- internals -----------------------------------------------------------

    /// Send one op as a JSON line, spawning the daemon lazily first.
    fn send_op(&self, op: Value) -> Result<String, String> {
        self.ensure_started()?;
        let id = protocol::op_id();
        let frame = format!("{}\n", json!({ "op": op, "id": id }));
        let mut inner = self.inner.lock().unwrap();
        let proc = inner.proc.as_mut().ok_or_else(|| "daemon is not running".to_string())?;
        let stdin = proc.stdin.as_mut().ok_or_else(|| "daemon stdin is closed".to_string())?;
        stdin
            .write_all(frame.as_bytes())
            .map_err(|error| format!("failed to write to daemon: {error}"))?;
        stdin.flush().map_err(|error| format!("failed to write to daemon: {error}"))?;
        Ok(id)
    }

    fn ensure_started(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.proc.is_some() {
            return Ok(());
        }
        let bin = inner.bin.clone();
        let cwd = inner.cwd.clone();
        let mut child = spawn_child(&bin, &cwd)?;
        let stdin = child.stdin.take().ok_or_else(|| "failed to capture daemon stdin".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "failed to capture daemon stdout".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "failed to capture daemon stderr".to_string())?;
        inner.proc = Some(Proc { child, stdin: Some(stdin) });
        inner.exit_code = None;
        inner.state.status = "idle".to_string();
        let state = Self::state_payload(&inner);

        let stdout_inner = Arc::clone(&self.inner);
        let stdout_emitter = Arc::clone(&self.emitter);
        thread::Builder::new()
            .name("cante-stdout".to_string())
            .spawn(move || stdout_loop(stdout, stdout_inner, stdout_emitter))
            .map_err(|error| format!("failed to start daemon reader: {error}"))?;
        let stderr_emitter = Arc::clone(&self.emitter);
        thread::Builder::new()
            .name("cante-stderr".to_string())
            .spawn(move || stderr_loop(stderr, stderr_emitter))
            .map_err(|error| format!("failed to start daemon log reader: {error}"))?;

        self.emitter.state(&state);
        Ok(())
    }

    fn ensure_version(&self) {
        let (bin, cwd, needed) = {
            let inner = self.inner.lock().unwrap();
            (inner.bin.clone(), inner.cwd.clone(), !inner.version_checked)
        };
        if !needed {
            return;
        }
        let version = run_capture(&bin, &["--version"], &cwd, VERSION_TIMEOUT)
            .ok()
            .map(|(stdout, _)| stdout.lines().next().unwrap_or("").trim().to_string())
            .filter(|line| !line.is_empty());
        let mut inner = self.inner.lock().unwrap();
        inner.cante = version;
        inner.version_checked = true;
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(proc) = inner.proc.as_mut() {
                // Drop stdin so a still-running daemon converges on EOF.
                drop(proc.stdin.take());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Command argument shapes
// ---------------------------------------------------------------------------

#[derive(Default, Debug, Clone)]
pub struct StartSessionArgs {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub cwd: Option<String>,
    pub resume_session_id: Option<String>,
}

/// Build the `Steer` op. The text is trimmed; blank steering is rejected.
pub fn steer_op(text: &str) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("text is required".to_string());
    }
    Ok(json!({ "Steer": text }))
}

/// Build the `ShellInput` op. A blank command is rejected.
pub fn shell_input_op(command: &str) -> Result<Value, String> {
    if command.trim().is_empty() {
        return Err("command is required".to_string());
    }
    Ok(json!({ "ShellInput": command }))
}

/// Build the `AmbientPhrase` op. `req_id` is echoed back on the `Ambient` event.
pub fn ambient_phrase_op(draft: &str, request_id: u64) -> Value {
    json!({ "AmbientPhrase": { "draft": draft, "req_id": request_id } })
}

/// Build the `AmbientSuggestion` op. `req_id` is echoed back on the `Ambient` event.
pub fn ambient_suggestion_op(recent_user: &str, recent_agent: &str, request_id: u64) -> Value {
    json!({ "AmbientSuggestion": {
        "recent_user": recent_user,
        "recent_agent": recent_agent,
        "req_id": request_id,
    }})
}

/// Build the `StartSession` / `ResumeSession` op for [`StartSessionArgs`].
///
/// The frozen frontend types spell `permission_mode` / `effort` PascalCase
/// while the daemon's wire enums are lowercase, so those values are folded to
/// lowercase here.
pub fn start_session_op(args: StartSessionArgs) -> Value {
    if let Some(session_id) = args.resume_session_id {
        return json!({ "ResumeSession": { "session_id": session_id, "unattended": false } });
    }
    let mut request = Map::new();
    for (key, value) in [
        ("model", args.model),
        ("provider", args.provider),
        ("permission_mode", args.permission_mode),
        ("effort", args.effort),
        ("cwd", args.cwd),
    ] {
        if let Some(value) = value {
            let value = match key {
                "permission_mode" | "effort" => value.to_ascii_lowercase(),
                _ => value,
            };
            request.insert(key.to_string(), Value::String(value));
        }
    }
    json!({ "StartSession": Value::Object(request) })
}

/// Build the `UpdateSession` op, accepting either a model id or a `ModelSpec`.
pub fn update_session_op(
    model: Option<Value>,
    permission_mode: Option<String>,
    title: Option<String>,
) -> Result<Value, String> {
    let mut update = Map::new();
    if let Some(model) = model {
        let mut spec = match model {
            Value::String(id) => json!({ "id": id }),
            other => other,
        };
        if let Some(Value::String(effort)) = spec.get_mut("effort") {
            *effort = effort.to_ascii_lowercase();
        }
        update.insert("model".to_string(), spec);
    }
    if let Some(mode) = permission_mode {
        update.insert("permission_mode".to_string(), Value::String(mode.to_ascii_lowercase()));
    }
    if let Some(title) = title {
        update.insert("title".to_string(), Value::String(title));
    }
    if update.is_empty() {
        return Err("nothing to update".to_string());
    }
    Ok(json!({ "UpdateSession": Value::Object(update) }))
}

// ---------------------------------------------------------------------------
// Child process plumbing
// ---------------------------------------------------------------------------

/// The daemon's own subcommand.
///
/// `CANTE_BIN` is allowed to spell it out — AGENTS.md §6 tells Windows users to
/// write `wsl.exe -e /home/<user>/cante-bin/ante serve` — so the callers below
/// have to recognize it instead of appending a second copy. `ante serve serve`
/// fails, and the failure reads like "the setting did not take effect" rather
/// than "the spec is misspelled".
const SERVE_SUBCOMMAND: &str = "serve";

/// Split a `CANTE_BIN` spec into the program and the arguments that follow it.
///
/// The spec may carry arguments so a script can stand in for `cante` on hosts
/// without shebang handling — Windows cannot execute `fake-cante.ts` directly,
/// so tests point `CANTE_BIN` at `"bun <script>"` there. Tokens may be quoted
/// with either quote style, because a Windows path may contain spaces and a WSL
/// bridge may carry a shell command line:
///
/// - `"C:\Program Files\cante\cante.exe" serve`
/// - `wsl.exe -d Ubuntu -e bash -lc 'cd /home/x && ./ante serve'`
///
/// Whitespace inside quotes is literal, so `&&` and friends stay inside one
/// argument instead of being shredded into several (which would make `-lc` run
/// `cd` and then a separate `./ante`). An unbalanced quote is tolerated — the
/// rest of the spec is taken literally — and an empty quoted token (`''`) is
/// dropped, because an empty program argument is never what a spec means.
///
/// This split is purely lexical: what a trailing `serve` means is decided by
/// [`serve_argv`] / [`helper_argv`], not here.
pub fn split_binary(spec: &str) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in spec.trim().chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        parts.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            },
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let mut iter = parts.into_iter();
    let program = iter.next().unwrap_or_else(|| "cante".to_string());
    (program, iter.collect())
}

/// `program` plus the exact arguments to spawn the daemon with.
///
/// A spec that already names the subcommand keeps the one the user wrote instead
/// of getting a second one: `wsl.exe -e /home/<user>/cante-bin/ante serve` runs
/// `ante serve`, not `ante serve serve`. A spec whose command line lives in a
/// shell payload (`bash -lc '<the whole command>'`) is passed through
/// untouched — the payload *is* the command line, and an extra `serve` would
/// only land in bash's `$0`.
pub fn serve_argv(spec: &str) -> (String, Vec<String>) {
    let (program, mut args) = split_binary(spec);
    if !names_serve(&args) {
        args.push(SERVE_SUBCOMMAND.to_string());
    }
    (program, args)
}

/// `program` plus the arguments for one of the daemon's *other* subcommands
/// (`--version`, `catalog`).
///
/// Those are not accepted after `serve` (`ante serve --version` is not a
/// thing), so a `serve` the spec names is dropped and `extra` takes its place:
/// `wsl.exe -e /home/<user>/cante-bin/ante serve` + `--version` runs
/// `wsl.exe -e /home/<user>/cante-bin/ante --version`. A spec without `serve`
/// (the fixture's `bun <script>`) is unchanged.
///
/// This is what makes the WSL bridge shippable at all: `health` needs a version
/// before the app considers itself ready (otherwise it says the engine is not
/// installed) and `catalog` feeds the provider list, so both have to reach the
/// binary *in front of* its subcommand.
///
/// A spec whose command line lives in a shell payload cannot be probed this
/// way — the payload would start the daemon instead. Use the plain form
/// (`wsl.exe -e /home/<user>/cante-bin/ante serve`) for anything the app has to
/// probe.
pub fn helper_argv(spec: &str, extra: &[&str]) -> (String, Vec<String>) {
    let (program, mut args) = split_binary(spec);
    if args.last().map(String::as_str) == Some(SERVE_SUBCOMMAND) {
        args.pop();
    }
    args.extend(extra.iter().map(|arg| arg.to_string()));
    (program, args)
}

/// Whether these arguments already name the daemon subcommand — as its own
/// token (`… ante serve`) or inside the shell payload of a `-c`-style flag
/// (`… bash -lc 'cd /home/x && ./ante serve'`), which takes the whole command
/// line as one argument.
fn names_serve(args: &[String]) -> bool {
    let Some(last) = args.last() else { return false };
    if last == SERVE_SUBCOMMAND {
        return true;
    }
    let is_payload =
        args.len() >= 2 && matches!(args[args.len() - 2].as_str(), "-c" | "-lc" | "--command");
    match last.strip_suffix(SERVE_SUBCOMMAND) {
        Some(head) => is_payload && (head.is_empty() || head.ends_with([' ', ';', '&', '|'])),
        None => false,
    }
}

/// Windows: `cante.exe` is a console program, so spawning it from a GUI process
/// flashes a console window (and can steal focus). `CREATE_NO_WINDOW` keeps the
/// child invisible while still giving it the piped stdio we own.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Everywhere else there is nothing to hide.
#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn spawn_child(bin: &str, cwd: &Path) -> Result<Child, String> {
    let (program, args) = serve_argv(bin);
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let line = std::iter::once(program.as_str())
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    command.spawn().map_err(|error| format!("could not start `{line}`: {error}"))
}

fn stdout_loop(stdout: ChildStdout, inner: Arc<Mutex<Inner>>, emitter: Arc<dyn Emitter>) {
    let mut reader = std::io::BufReader::new(stdout);
    let mut splitter = LineSplitter::default();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                for line in splitter.push(&buffer[..n]) {
                    handle_stdout_line(&line, &inner, &emitter);
                }
            }
            Err(_) => break,
        }
    }
    if let Some(line) = splitter.finish() {
        handle_stdout_line(&line, &inner, &emitter);
    }
    finalize_exit(&inner, &emitter);
}

fn handle_stdout_line(line: &str, inner: &Arc<Mutex<Inner>>, emitter: &Arc<dyn Emitter>) {
    match serde_json::from_str::<Value>(line) {
        Ok(event) => {
            let state = {
                let mut guard = inner.lock().unwrap();
                guard.ring.push(event.clone());
                // The ring keeps the whole `EventMsg` envelope, but the state
                // machine folds the inner `event` payload.
                if let Some(inner_event) = event.get("event") {
                    protocol::reduce_state(&mut guard.state, inner_event);
                }
                Daemon::state_payload(&guard)
            };
            emitter.event(&event);
            emitter.state(&state);
        }
        Err(_) => emitter.log("stdout", line),
    }
}

fn stderr_loop(stderr: ChildStderr, emitter: Arc<dyn Emitter>) {
    let mut reader = std::io::BufReader::new(stderr);
    let mut splitter = LineSplitter::default();
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                for line in splitter.push(&buffer[..n]) {
                    emitter.log("stderr", &line);
                }
            }
            Err(_) => break,
        }
    }
    if let Some(line) = splitter.finish() {
        emitter.log("stderr", &line);
    }
}

/// How long a daemon that closed its pipes may keep running before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// Wait for a child that already lost its pipes, killing it if it lingers.
///
/// Called from the stdout reader on EOF, never while the daemon mutex is held:
/// a process that closes stdout but stays alive is not unusual (a wrapper, a
/// wedged daemon), and blocking on it would wedge every later command.
fn reap(child: &mut Child) -> Option<i32> {
    let deadline = Instant::now() + EXIT_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn finalize_exit(inner: &Arc<Mutex<Inner>>, emitter: &Arc<dyn Emitter>) {
    let (taken, code, state) = {
        let mut guard = inner.lock().unwrap();
        let taken = guard.proc.take();
        let code = if taken.is_none() { guard.exit_code } else { None };
        guard.state.status = "offline".to_string();
        guard.state.session = None;
        guard.state.pending_approval = None;
        (taken, code, Daemon::state_payload(&guard))
    };
    emitter.state(&state);

    let Some(mut proc) = taken else {
        // Already finalized (for example by `shutdown`): report the last code.
        emitter.exit(code);
        return;
    };

    // Closing stdin is how the daemon converges when it ignores `Shutdown`.
    drop(proc.stdin.take());
    let reaper_inner = Arc::clone(inner);
    let reaper_emitter = Arc::clone(emitter);
    let fallback_emitter = Arc::clone(emitter);
    let spawned = thread::Builder::new()
        .name("cante-reap".to_string())
        .spawn(move || {
            let code = reap(&mut proc.child);
            if let Ok(mut guard) = reaper_inner.lock() {
                guard.exit_code = code;
            }
            reaper_emitter.exit(code);
        });
    if spawned.is_err() {
        // No thread available: report the exit rather than blocking this reader
        // on a process that may never die. The next command spawns a fresh one.
        fallback_emitter.exit(None);
    }
}

// ---------------------------------------------------------------------------
// Out-of-process helpers (`--version`, `catalog`)
// ---------------------------------------------------------------------------

fn run_capture(
    bin: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<(String, String), String> {
    let (program, leading) = helper_argv(bin, args);
    let mut command = Command::new(&program);
    command
        .args(&leading)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run `{bin} {}`: {error}", args.join(" ")))?;
    let mut stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let mut stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let out_handle = thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err_handle = thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(error.to_string());
            }
        }
    }
    let out = out_handle.join().unwrap_or_default();
    let err = err_handle.join().unwrap_or_default();
    Ok((out, err))
}

fn suffix(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(": {trimmed}")
    }
}
