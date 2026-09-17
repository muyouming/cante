//! Protocol adapter: the Cante `Op`/`Evt` JSONL protocol on stdio, in front of
//! `pi --mode rpc` (issue #103, plan C, first segment).
//!
//! `daemon.rs` spawns `CANTE_BIN` (a command spec) and appends `serve`. Pointing
//! `CANTE_BIN` at this crate's `cante-bridge` binary therefore replaces the
//! upstream daemon without touching the Rust bridge or the frontend: the
//! adapter reads `{"op":…,"id":"op_<ULID>"}` lines on stdin, drives a `pi`
//! child, and writes `EventMsg` lines on stdout.
//!
//! Scope (see `gui/docs/BRIDGE-spike.md` and `gui/docs/BRIDGE-gate.md`):
//!
//! * `StartSession` → spawn `pi --mode rpc` + emit `SessionStart`;
//! * `UserInput` → `prompt` → `MessageDelta`/`AgentMessage`/`TurnEnd`;
//! * `Interrupt` → `abort` → `TurnEnd{Interrupted}`;
//! * the approval gate: a bundled pi extension blocks every `tool_call`, the
//!   adapter turns its `extension_ui_request` into `TurnPause{Approval}` and
//!   the client's `ApprovalResponse` back into the extension's answer.
//!
//! Deliberately **not** here: permission *policy* (which calls deserve a
//! question, `strict`/`auto`/`yolo`, danger detection, persisted allow rules),
//! usage reporting, session persistence/resume, skills/subagents, multiple
//! sessions, Windows packaging. Unsupported ops answer with an `Error` event
//! instead of silently doing nothing, so a future wiring mistake is visible.
//!
//! Three probe findings shape the translation and are easy to get wrong:
//!
//! * `turn_end` is one *assistant reply*, not a user turn — a prompt with a tool
//!   call produces two of them. `TurnEnd` is therefore emitted only on
//!   `agent_settled`; `turn_end`/`turn_start` only count `steps`.
//! * `message_start` carries a partial snapshot; `message_end.message` is
//!   authoritative, so `AgentMessage` comes from there.
//! * `tool_execution_start` fires **before** the approval hook, so a `ToolStart`
//!   is held until the gate decides; otherwise the progress list would already
//!   say "running" behind an open approval sheet (PROBE §3 B).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::protocol::{self, LineSplitter};

/// The line `cante-bridge --version` prints. `health` only checks it is non-empty.
pub const VERSION: &str = concat!("cante-bridge ", env!("CARGO_PKG_VERSION"));

/// How long `get_state` may take before `SessionStart` is emitted without it.
const STATE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `pi` may keep running after its stdin is closed before it is killed.
const PI_EXIT_GRACE: Duration = Duration::from_secs(5);

/// Version tag for the adapter↔extension approval encoding. `options[0]` of the
/// dialog request and the JSON in the response value both carry it, so a future
/// change on one side cannot silently speak the old language to the other.
const GATE_MARKER: &str = "cante-gate:v1";
/// The pi extension that blocks `tool_call`. Embedded so `cante-bridge` carries
/// it: `pi -e` needs a real file, and a released binary cannot read the source
/// tree. [`gate_extension_path`] materializes it under the temp dir.
const GATE_EXTENSION: &str = include_str!("../bridge-extension/index.ts");
/// Shown to the model when the user denies without writing a reason.
const DEFAULT_DENY_REASON: &str = "用户拒绝了这个操作";

/// Lock a mutex, ignoring poisoning: a panicked writer must not wedge the
/// adapter that the desktop app depends on.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Pure translation: one `pi` event → zero or more Cante `Evt`s
// ---------------------------------------------------------------------------

/// Everything the translator has to remember between `pi` events.
#[derive(Default, Debug)]
struct TurnState {
    turn_id: Option<String>,
    /// Assistant replies in the current user turn (`turn_start` count).
    steps: u32,
    /// The last assistant `stopReason` seen (`"stop"`, `"aborted"`, `"error"`, …).
    stop_reason: Option<String>,
    /// The last `errorMessage` seen, verbatim.
    error_message: Option<String>,
    /// The user pressed stop during this turn.
    requested_abort: bool,
    /// A user turn is in flight (from `agent_start` to `agent_settled`).
    active: bool,
    /// Per-tool accumulated result text, to turn `pi`'s cumulative
    /// `tool_execution_update` into the deltas `ToolUpdate` carries.
    partials: HashMap<String, String>,
    /// Per-tool update counter (`ToolUpdate.seq`).
    seqs: HashMap<String, u32>,
    /// `ToolStart` payloads held back until the gate decides (PROBE §3 B).
    held_starts: HashMap<String, Value>,
    /// Tools the gate allowed before their `tool_execution_start` arrived.
    allowed_ahead: HashSet<String>,
    /// Tools the gate denied before their `tool_execution_start` arrived; the
    /// start must still open a row before it is closed as `Denied`.
    denied_ahead: HashSet<String>,
    /// Tools already reported closed as `Denied`; the `tool_execution_end`
    /// that pi still sends afterwards must not be reported a second time.
    denied_reported: HashSet<String>,
    /// The open approval pause, if the gate is waiting for the window.
    gate: Option<PendingGate>,
    /// The reason attached to the current denial, echoed to the model.
    deny_reason: String,
    /// The model's context window (`get_state` → `model.contextWindow`), the
    /// divisor for `UsageUpdate.context`. Session-scoped, so `begin_turn` must
    /// not clear it. `None` means pi did not report a limit, and the context
    /// snapshot is then left out rather than guessed.
    context_limit: Option<u32>,
}

/// One `extension_ui_request` from the gate extension, waiting for the
/// window's [`approve`](Session::approval_response).
#[derive(Debug)]
struct PendingGate {
    turn_id: String,
    /// The dialog id to answer once the decision arrives.
    request_id: String,
    /// The calls still to be decided, in the order the model asked for them.
    tools: Vec<Value>,
}

/// A `ToolEnd` for a call the user refused: no process ran, and the UI reads
/// the status (not `isError`) to colour the row.
fn denied_tool_end(id: &str, name: &str, reason: &str) -> Value {
    json!({ "ToolEnd": {
        "tool_use_id": id,
        "tool_name": name,
        "status": "Denied",
        "result_json": { "content": [{ "type": "text", "text": reason }] },
    }})
}

fn tool_payload_name(payload: &Value) -> String {
    payload.get("name").and_then(Value::as_str).unwrap_or("").to_string()
}

fn tool_id(tool: &Value) -> &str {
    tool.get("id").and_then(Value::as_str).unwrap_or("")
}

fn tool_name(tool: &Value) -> &str {
    tool.get("name").and_then(Value::as_str).unwrap_or("")
}

impl TurnState {
    fn begin_turn(&mut self) {
        self.turn_id = Some(format!("turn_{}", protocol::ulid()));
        self.steps = 0;
        self.stop_reason = None;
        self.error_message = None;
        self.requested_abort = false;
        self.active = true;
        self.partials.clear();
        self.seqs.clear();
        self.held_starts.clear();
        self.allowed_ahead.clear();
        self.denied_ahead.clear();
        self.denied_reported.clear();
        self.gate = None;
        self.deny_reason.clear();
    }

    /// Record a `tool_execution_start`; the `ToolStart` is held until the gate
    /// decides (or until execution proves no gate is coming).
    fn hold_start(&mut self, id: &str, payload: Value) -> Vec<Value> {
        if self.denied_ahead.remove(id) {
            self.denied_reported.insert(id.to_string());
            let name = tool_payload_name(&payload);
            return vec![json!({ "ToolStart": payload }), denied_tool_end(id, &name, &self.deny_reason)];
        }
        if self.allowed_ahead.remove(id) {
            return vec![json!({ "ToolStart": payload })];
        }
        self.held_starts.insert(id.to_string(), payload);
        Vec::new()
    }

    /// Apply the user's decision to one call: release a held `ToolStart`, close
    /// a denied call (or remember both for a start that has not arrived yet).
    fn decide(&mut self, id: &str, allowed: bool) -> Vec<Value> {
        if let Some(payload) = self.held_starts.remove(id) {
            let name = tool_payload_name(&payload);
            let mut out = vec![json!({ "ToolStart": payload })];
            if !allowed {
                out.push(denied_tool_end(id, &name, &self.deny_reason));
                self.denied_reported.insert(id.to_string());
            }
            return out;
        }
        if allowed {
            self.allowed_ahead.insert(id.to_string());
        } else {
            self.denied_ahead.insert(id.to_string());
        }
        Vec::new()
    }

    /// Release a held `ToolStart` because the call is running without a gate
    /// (execution reached an update/end first).
    fn take_start(&mut self, id: &str) -> Option<Value> {
        self.held_starts.remove(id).map(|payload| json!({ "ToolStart": payload }))
    }

    /// Close every still-held start as `Cancelled`: used when the turn ends
    /// (interrupt while the sheet is open) so no row stays "running" forever.
    fn flush_cancelled(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        let held: Vec<(String, Value)> = self.held_starts.drain().collect();
        for (id, payload) in held {
            let name = tool_payload_name(&payload);
            out.push(json!({ "ToolStart": payload }));
            out.push(json!({ "ToolEnd": {
                "tool_use_id": id,
                "tool_name": name,
                "status": "Cancelled",
                "result_json": Value::Null,
            }}));
        }
        out
    }

    /// The current turn id, minting one if `pi` skipped `agent_start`.
    fn current_turn_id(&mut self) -> String {
        if self.turn_id.is_none() {
            self.turn_id = Some(format!("turn_{}", protocol::ulid()));
        }
        self.turn_id.clone().expect("turn id was just set")
    }

    fn record_stop_reason(&mut self, message: &Value) {
        if let Some(reason) = message.get("stopReason").and_then(Value::as_str) {
            self.stop_reason = Some(reason.to_string());
        }
        if let Some(error) = message.get("errorMessage").and_then(Value::as_str) {
            if !error.is_empty() {
                self.error_message = Some(error.to_string());
            }
        }
    }

    /// The `TurnEnd.status` for the turn that just settled.
    fn end_status(&self) -> Value {
        // A stop the user asked for wins over whatever pi reports. Aborting a
        // tool preflight that is sitting in the approval hook surfaces as
        // `stopReason:"error"` / `"This operation was aborted"`; showing that
        // as a failure would alarm her for pressing Stop (probe finding G).
        if self.requested_abort {
            return json!({ "Interrupted": { "reason": "user" } });
        }
        match self.stop_reason.as_deref() {
            Some("error") => {
                let headline = self
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "助手在回答的时候出错了".to_string());
                json!({ "Error": { "headline": headline } })
            }
            // `pi` says it was aborted: "被中止", never "完成".
            Some("aborted") => json!({ "Interrupted": { "reason": "user" } }),
            _ => json!("Completed"),
        }
    }
}

/// Join the text blocks of a `content` array (assistant message or tool result).
fn text_of_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// One token counter out of a `pi` usage report, clamped to the `u32` the wire
/// shape carries.
fn token_count(usage: &Value, key: &str) -> u32 {
    usage
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|count| u32::try_from(count).ok())
        .unwrap_or(0)
}

/// Translate one `pi` usage report into a `UsageUpdate`, or `None` when `pi`
/// reported nothing.
///
/// pi's `input` **excludes** the cache buckets — measured on `pi 0.85.1`: the
/// `openai-completions` mapping computes `input = prompt_tokens − cacheRead −
/// cacheWrite`, and `totalTokens = input + output + cacheRead + cacheWrite` —
/// while Cante's `input_tokens` is the full, cache-inclusive prompt size
/// (`crates/protocol-shape`). The buckets are added back rather than passed
/// through, or a mostly-cached prompt would read as a tiny one and the context
/// snapshot would come out too small.
///
/// An all-zero report is pi saying "the provider sent no usage" (it stays zero
/// during streaming, PROBE §3 C). That must not become a `UsageUpdate` full of
/// zeros: no measurement is not a measurement of zero.
fn usage_event(usage: Option<&Value>, context_limit: Option<u32>) -> Option<Value> {
    let usage = usage.filter(|usage| usage.is_object())?;
    let cache_read = token_count(usage, "cacheRead");
    let cache_write = token_count(usage, "cacheWrite");
    let output = token_count(usage, "output");
    let input = token_count(usage, "input")
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    if input == 0 && output == 0 {
        return None;
    }
    let mut update = Map::new();
    update.insert(
        "usage".to_string(),
        json!({
            "input_tokens": input,
            "output_tokens": output,
            "cache_read_tokens": cache_read,
            "cache_creation_tokens": cache_write,
        }),
    );
    // The occupancy snapshot describes the response that just finished, so it
    // is only meaningful together with a limit pi actually reported.
    if let Some(limit) = context_limit.filter(|limit| *limit > 0) {
        update.insert(
            "context".to_string(),
            json!({ "used_tokens": input.saturating_add(output), "limit_tokens": limit }),
        );
    }
    Some(json!({ "UsageUpdate": Value::Object(update) }))
}

/// Translate one `pi` RPC event into Cante `Evt` payloads.
///
/// Events that are part of the RPC sub-protocol (`response`,
/// `extension_ui_request`) are handled by the runtime, not here.
fn translate(event: &Value, state: &mut TurnState) -> Vec<Value> {
    match str_field(event, "type") {
        "agent_start" => {
            // pi emits `agent_start` again when a run continues (observed:
            // twice for one tool-calling prompt). A Cante turn is one user
            // prompt, so only the first one opens a turn; otherwise every
            // continuation would mint a new `turn_id` and the closing TurnEnd
            // would not match the TurnStart the UI saw.
            if state.active {
                return Vec::new();
            }
            state.begin_turn();
            let turn_id = state.current_turn_id();
            vec![json!({ "TurnStart": { "turn_id": turn_id } })]
        }
        // One assistant reply starts here; `TurnEnd` is reserved for
        // `agent_settled` because a prompt can contain several replies.
        "turn_start" => {
            state.steps = state.steps.saturating_add(1);
            Vec::new()
        }
        "message_update" => {
            let Some(delta) = event.get("assistantMessageEvent") else {
                return Vec::new();
            };
            let text = delta.get("delta").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            match str_field(delta, "type") {
                "text_delta" => vec![json!({ "MessageDelta": text })],
                "thinking_delta" => vec![json!({ "ThinkingDelta": text })],
                _ => Vec::new(),
            }
        }
        "message_end" => {
            let Some(message) = event.get("message") else {
                return Vec::new();
            };
            // `pi` echoes the user prompt as a `role:"user"` message; the
            // adapter emits its own `UserInput`, so the echo is dropped here.
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return Vec::new();
            }
            state.record_stop_reason(message);
            let mut out = Vec::new();
            let text = text_of_content(message.get("content"));
            if !text.is_empty() {
                out.push(json!({ "AgentMessage": text }));
            }
            // Usage rides the same authoritative message; a tool-call-only
            // reply has no text but still accounts for its own tokens.
            out.extend(usage_event(message.get("usage"), state.context_limit));
            out
        }
        "tool_execution_start" => {
            let id = str_field(event, "toolCallId").to_string();
            state.partials.insert(id.clone(), String::new());
            state.seqs.insert(id.clone(), 0);
            let payload = json!({
                "id": id.clone(),
                "name": str_field(event, "toolName"),
                "args": event.get("args").cloned().unwrap_or(Value::Null),
            });
            // Held, not emitted: `tool_execution_start` fires before the
            // approval hook, and the progress list must not say "running"
            // while the approval sheet is still open (PROBE §3 B).
            state.hold_start(&id, payload)
        }
        "tool_execution_update" => {
            let id = str_field(event, "toolCallId").to_string();
            if state.denied_reported.contains(&id) {
                return Vec::new();
            }
            // An update proves execution started, so any held start is genuine
            // (the gate allowed it, or no gate was loaded at all). Release it
            // before the update so the row exists to append to.
            let mut out: Vec<Value> = state.take_start(&id).into_iter().collect();
            let full = text_of_content(event.get("partialResult").and_then(|r| r.get("content")));
            let previous = state.partials.get(&id).cloned().unwrap_or_default();
            // `pi` sends the accumulated output; `ToolUpdate` carries what to
            // append. A payload that is not an extension of the last one is
            // passed through whole rather than dropped.
            let delta = match full.strip_prefix(previous.as_str()) {
                Some(rest) => rest.to_string(),
                None => full.clone(),
            };
            state.partials.insert(id.clone(), full);
            if delta.is_empty() {
                return out;
            }
            let seq = state.seqs.entry(id.clone()).or_insert(0);
            *seq = seq.saturating_add(1);
            out.push(json!({ "ToolUpdate": {
                "tool_use_id": id,
                "seq": *seq,
                "message": delta,
            }}));
            out
        }
        "tool_execution_end" => {
            let id = str_field(event, "toolCallId").to_string();
            state.partials.remove(&id);
            state.seqs.remove(&id);
            // A call the user denied was already closed as `Denied`; pi still
            // sends its (error) result, which must not become a second row.
            if state.denied_reported.remove(&id) {
                return Vec::new();
            }
            let mut out: Vec<Value> = state.take_start(&id).into_iter().collect();
            let failed = event.get("isError").and_then(Value::as_bool).unwrap_or(false);
            out.push(json!({ "ToolEnd": {
                "tool_use_id": id,
                "tool_name": str_field(event, "toolName"),
                "status": if failed { "Failed" } else { "Completed" },
                "result_json": event.get("result").cloned().unwrap_or(Value::Null),
            }}));
            out
        }
        // Authoritative stop reason lives on the assistant message.
        "turn_end" => {
            if let Some(message) = event.get("message") {
                state.record_stop_reason(message);
            }
            Vec::new()
        }
        "agent_settled" => {
            let turn_id = state.current_turn_id();
            let status = state.end_status();
            let steps = state.steps;
            // An interrupt can land while the approval sheet is open: close
            // whatever start is still held so no row is left "running".
            let mut out = state.flush_cancelled();
            state.active = false;
            state.gate = None;
            state.partials.clear();
            state.seqs.clear();
            state.allowed_ahead.clear();
            state.denied_ahead.clear();
            state.denied_reported.clear();
            out.push(json!({ "TurnEnd": { "turn_id": turn_id, "status": status, "steps": steps } }));
            out
        }
        "compaction_start" => vec![json!("CompactStart")],
        "compaction_end" => {
            let result = event.get("result");
            let summary = result
                .and_then(|result| result.get("summary"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut out = vec![json!({ "CompactEnd": { "summary": summary } })];
            // Summarizing is a model response too, so its tokens count; pi
            // reports them under `result.usage` (`rpc.md` §compaction_end).
            out.extend(usage_event(
                result.and_then(|result| result.get("usage")),
                state.context_limit,
            ));
            out
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// SessionInfo
// ---------------------------------------------------------------------------

/// Fold Cante's PascalCase permission modes onto `pi`'s world, and back.
fn permission_mode_wire(value: Option<&str>) -> &'static str {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("strict") => "Strict",
        Some("yolo") => "Yolo",
        _ => "Auto",
    }
}

fn model_spec(model: Option<&Value>) -> Value {
    let mut spec = Map::new();
    match model {
        Some(model) if model.is_object() => {
            spec.insert("id".to_string(), model.get("id").cloned().unwrap_or(json!("")));
            if let Some(name) = model.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    spec.insert("display_name".to_string(), json!(name));
                }
            }
            // `input` is where pi says text vs image. Absent means "pi did not
            // say", which the frontend reads as "cannot see images" — never
            // invented here.
            if let Some(input) = model.get("input").and_then(Value::as_array) {
                let vision = input.iter().any(|item| item.as_str() == Some("image"));
                spec.insert("support_vision".to_string(), json!(vision));
            }
        }
        _ => {
            spec.insert("id".to_string(), json!(""));
        }
    }
    Value::Object(spec)
}

fn provider_spec(model: Option<&Value>) -> Value {
    let base_url = model
        .and_then(|model| model.get("baseUrl"))
        .and_then(Value::as_str)
        .unwrap_or("");
    // The wire shape (`crates/protocol-shape`) types both fields as required
    // strings, so an unknown provider is the empty string, not a guess: the
    // privacy panel then falls back to `provider.id`.
    json!({
        "id": model.and_then(|model| model.get("provider")).and_then(Value::as_str).unwrap_or(""),
        "display_name": "",
        "base_url": base_url,
    })
}

/// Build the `SessionStart` payload from a `get_state` response.
///
/// Fields pi cannot answer are left empty rather than guessed: `session_id` and
/// `model.id` are `""`, `title` is `null`, and `skills` is `[]` (skills are out
/// of scope for this segment).
fn session_info(
    state: Option<&Value>,
    cwd: &str,
    permission_mode: Option<&str>,
) -> Value {
    let model = state.and_then(|state| state.get("model")).filter(|value| !value.is_null());
    let session_id = state
        .and_then(|state| state.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    json!({
        "model": model_spec(model),
        "provider": provider_spec(model),
        "session_id": session_id,
        "cwd": cwd,
        "permission_mode": permission_mode_wire(permission_mode),
        "title": Value::Null,
        "skills": [],
    })
}

// ---------------------------------------------------------------------------
// Envelope + timestamps
// ---------------------------------------------------------------------------

fn now_iso8601() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0);
    iso8601_from_ms(ms)
}

/// RFC 3339 UTC with milliseconds, without pulling in a date library.
fn iso8601_from_ms(ms: u64) -> String {
    let seconds = ms / 1000;
    let millis = ms % 1000;
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let second_of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
    )
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// `pi` process plumbing
// ---------------------------------------------------------------------------

/// The `StartSession` request fields this segment understands.
#[derive(Default, Debug, Clone)]
struct StartArgs {
    model: Option<String>,
    provider: Option<String>,
    permission_mode: Option<String>,
    cwd: Option<String>,
}

impl StartArgs {
    fn parse(request: &Value) -> Self {
        let get = |key: &str| request.get(key).and_then(Value::as_str).map(str::to_string);
        Self {
            model: get("model"),
            provider: get("provider"),
            permission_mode: get("permission_mode"),
            cwd: get("cwd"),
        }
    }
}

/// Arguments for the `pi` child. `--no-session` matches this segment's scope:
/// session persistence/resume is not wired up, so claiming it would be a lie.
/// `extension` is the materialized approval gate ([`gate_extension_path`]).
fn pi_args(args: &StartArgs, extension: Option<&Path>) -> Vec<String> {
    let mut out = vec!["--mode".to_string(), "rpc".to_string(), "--no-session".to_string()];
    if let Some(path) = extension {
        out.push("-e".to_string());
        out.push(path.to_string_lossy().into_owned());
    }
    if let Some(provider) = &args.provider {
        out.push("--provider".to_string());
        out.push(provider.clone());
    }
    if let Some(model) = &args.model {
        out.push("--model".to_string());
        out.push(model.clone());
    }
    out
}

/// Write the bundled gate extension next to nothing anyone owns, and return the
/// path to hand to `pi -e`.
///
/// The file name is derived from the source, so two bridge processes (or two
/// test runs) writing the same source cannot race with different contents, and
/// a crashed process leaves nothing to clean up. Failure is fatal on purpose:
/// without the extension no tool call is gated, and a session that can run
/// tools unasked breaks product law 2.
fn gate_extension_path() -> Result<PathBuf, String> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in GATE_EXTENSION.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let name = format!("cante-bridge-gate-{hash:016x}.ts");
    let path = std::env::temp_dir().join(&name);
    materialize(&path, GATE_EXTENSION)?;
    Ok(path)
}

/// Put `contents` at `path`, atomically where the platform allows it.
///
/// The content-addressed name means the common case is "already there": two
/// bridge processes (or two test binaries) share one temp dir and one file, and
/// whoever gets there first must not be punished. The bytes go to a pid-named
/// scratch file first and are then moved into place, so a reader never sees
/// half a file.
///
/// The retry around `rename` is a **Windows** fact: unix replaces the
/// destination silently, but `MoveFile` fails with `AlreadyExists` when the
/// target exists. Without the retry a stale file — a crash between write and
/// rename, or a gate left by an older build whose content hash differed — would
/// make every later session fail with "没能准备好审批要用的文件", on the one
/// platform this whole bridge exists for.
fn materialize(path: &Path, contents: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    let scratch = scratch_path(path);
    std::fs::write(&scratch, contents)
        .map_err(|error| format!("没能准备好审批要用的文件（{scratch:?}）：{error}"))?;
    match std::fs::rename(&scratch, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // A sibling process may have won the race with the same bytes —
            // that is success, not failure. Otherwise the file in the way is
            // stale and has to go before we can move ours in.
            if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
                let _ = std::fs::remove_file(&scratch);
                return Ok(());
            }
            let _ = std::fs::remove_file(path);
            match std::fs::rename(&scratch, path) {
                Ok(()) => Ok(()),
                Err(retry) => {
                    let _ = std::fs::remove_file(&scratch);
                    Err(format!("没能准备好审批要用的文件（{path:?}）：{retry}"))
                }
            }
        }
    }
}

/// Where [`materialize`] writes before moving the file into place. Named by pid
/// so two processes never write each other's bytes.
fn scratch_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.{}.tmp", std::process::id()))
}

fn pi_program() -> String {
    std::env::var("PI_BIN")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "pi".to_string())
}

/// Windows: `pi` is a console program; spawning it from the window process
/// would flash a console. Same treatment `daemon.rs` gives `cante`.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn close_pi_stdin(stdin: &Arc<Mutex<Option<ChildStdin>>>) {
    if let Ok(mut guard) = stdin.lock() {
        drop(guard.take());
    }
}

/// Wait for a child that already lost its pipes, killing it if it lingers.
fn reap(mut child: Child) {
    let deadline = Instant::now() + PI_EXIT_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

/// The fail-safe answer to a dialog that is **not** our approval gate. An
/// unexpected dialog must not hang the turn: answering "cancelled" is the
/// direction the probe measured (the extension sees no/false).
fn ui_response_for(request: &Value) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str)?;
    if !matches!(method, "select" | "confirm" | "input" | "editor") {
        return None;
    }
    let id = request.get("id")?;
    Some(json!({ "type": "extension_ui_response", "id": id, "cancelled": true }))
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type Sink = Arc<Mutex<std::io::Stdout>>;

/// State shared with the `pi` stdout reader thread.
struct Shared {
    /// The op id that caused the current turn (used as `EventMsg.parent`).
    parent: Option<String>,
    turn: TurnState,
    /// pi tool names the user chose "allow from now on" for. Scoped to this
    /// bridge process: `AcceptAlways` is **not** persisted (BRIDGE-gate.md).
    always_allowed: HashSet<String>,
}

/// The running `pi` child.
struct Pi {
    child: Child,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

struct ReaderCtx {
    sink: Sink,
    shared: Arc<Mutex<Shared>>,
    state_tx: mpsc::Sender<Value>,
    shutting_down: Arc<AtomicBool>,
    /// Set once `SessionStart` has been announced.
    started: Arc<AtomicBool>,
    pi_stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// Run the adapter on stdin/stdout until stdin closes or `Shutdown` arrives.
/// Returns the process exit code.
pub fn serve() -> i32 {
    let sink: Sink = Arc::new(Mutex::new(std::io::stdout()));
    let mut session = Session::new(sink);
    session.serve_stdin();
    session.finish();
    0
}

struct Session {
    sink: Sink,
    shared: Arc<Mutex<Shared>>,
    shutting_down: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    pi: Option<Pi>,
    state_rx: Option<mpsc::Receiver<Value>>,
    args: StartArgs,
    stop: bool,
}

impl Session {
    fn new(sink: Sink) -> Self {
        Self {
            sink,
            shared: Arc::new(Mutex::new(Shared {
                parent: None,
                turn: TurnState::default(),
                always_allowed: HashSet::new(),
            })),
            shutting_down: Arc::new(AtomicBool::new(false)),
            started: Arc::new(AtomicBool::new(false)),
            pi: None,
            state_rx: None,
            args: StartArgs::default(),
            stop: false,
        }
    }

    // -- stdin ---------------------------------------------------------------

    fn serve_stdin(&mut self) {
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut splitter = LineSplitter::default();
        let mut buffer = [0u8; 8192];
        while !self.stop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    for line in splitter.push(&buffer[..n]) {
                        self.handle_line(&line);
                        if self.stop {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(line) = splitter.finish() {
            self.handle_line(&line);
        }
    }

    fn handle_line(&mut self, line: &str) {
        let frame: Value = match serde_json::from_str(line) {
            Ok(frame) => frame,
            Err(_) => {
                eprintln!("cante-bridge: ignoring a non-JSON stdin line");
                return;
            }
        };
        let op = frame.get("op").cloned().unwrap_or(Value::Null);
        let id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        self.handle_op(&op, &id);
    }

    fn handle_op(&mut self, op: &Value, id: &str) {
        match op {
            Value::String(name) => match name.as_str() {
                "Interrupt" => self.interrupt(id),
                "Shutdown" => self.stop = true,
                other => self.unsupported(other, id),
            },
            Value::Object(map) => {
                if let Some(request) = map.get("StartSession") {
                    self.start_session(request, id);
                } else if let Some(text) = map.get("UserInput").and_then(Value::as_str) {
                    self.user_input(text, id);
                } else if let Some(request) = map.get("ApprovalResponse") {
                    self.approval_response(request, id);
                } else if map.contains_key("ResumeSession") {
                    self.unsupported("ResumeSession", id);
                } else if let Some(name) = map.keys().next() {
                    self.unsupported(name, id);
                }
            }
            _ => {}
        }
    }

    fn start_session(&mut self, request: &Value, id: &str) {
        self.args = StartArgs::parse(request);
        // A session is a fresh permission context: "allow from now on" does not
        // survive into the next one.
        lock(&self.shared).always_allowed.clear();
        if let Err(error) = self.ensure_pi(id) {
            self.error(&error, Some(id));
        }
    }

    fn user_input(&mut self, text: &str, id: &str) {
        if let Err(error) = self.ensure_pi(id) {
            self.error(&error, Some(id));
            return;
        }
        let streaming = lock(&self.shared).turn.active;
        lock(&self.shared).parent = Some(id.to_string());
        // The daemon echoes the prompt as `UserInput`; the transcript's "you"
        // row is rendered from it (the store does not render the local send).
        emit(&self.sink, json!({ "UserInput": text }), Some(id));
        let mut command = json!({ "id": id, "type": "prompt", "message": text });
        if streaming {
            // One thing at a time is the product's model, but a second prompt
            // must not be dropped on the floor: pi queues it as steering.
            command["streamingBehavior"] = json!("steer");
        }
        if let Err(error) = self.write_pi(&command) {
            self.error(&error, Some(id));
        }
    }

    fn interrupt(&mut self, id: &str) {
        let paused = {
            let mut shared = lock(&self.shared);
            shared.parent = Some(id.to_string());
            shared.turn.requested_abort = true;
            // pi resolves an open dialog on abort, but only if the extension
            // forwarded the turn signal; answering "cancelled" here is what
            // makes stop work while the approval sheet is open. Clearing the
            // gate also means a late ApprovalResponse cannot answer a pause
            // that is already over.
            shared.turn.gate.take().map(|gate| gate.request_id)
        };
        if let Some(request_id) = paused {
            let cancel = json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true });
            let _ = self.write_pi(&cancel);
        }
        if self.pi.is_none() {
            return;
        }
        if let Err(error) = self.write_pi(&json!({ "id": id, "type": "abort" })) {
            self.error(&error, Some(id));
        }
    }

    /// `ApprovalResponse` — translate the window's per-call decisions back into
    /// the gate extension's single encoded answer, then release the held
    /// `ToolStart`s the pause is sitting on top of.
    fn approval_response(&mut self, request: &Value, op_id: &str) {
        let turn_id = request.get("turn_id").and_then(Value::as_str).unwrap_or("").to_string();
        let responses = request.get("responses").and_then(Value::as_array).cloned().unwrap_or_default();

        let (request_id, encoded, events, parent) = {
            let mut shared = lock(&self.shared);
            let Some(gate) = shared.turn.gate.take() else {
                eprintln!("cante-bridge: approval arrived while nothing was paused");
                return;
            };
            if gate.turn_id != turn_id {
                eprintln!("cante-bridge: approval turn id did not match the open pause");
                shared.turn.gate = Some(gate);
                return;
            }
            let plan = plan_gate(&gate.tools, &responses);
            for name in plan.remember.iter().cloned() {
                shared.always_allowed.insert(name);
            }
            shared.turn.deny_reason = plan.reason.clone();
            let mut events = Vec::new();
            for tool in &gate.tools {
                let id = tool_id(tool);
                events.extend(shared.turn.decide(id, plan.allow.iter().any(|allowed| allowed == id)));
            }
            let allow = plan.allow;
            let deny = plan.deny;
            (
                gate.request_id,
                json!({ "v": 1, "allow": allow, "deny": deny, "reason": plan.reason }).to_string(),
                events,
                shared.parent.clone(),
            )
        };

        let response = json!({ "type": "extension_ui_response", "id": request_id, "value": encoded });
        if let Err(error) = self.write_pi(&response) {
            self.error(&error, Some(op_id));
        }
        // Close the sheet before the released tools appear, so the progress
        // list cannot say "running" behind an open approval prompt.
        emit(&self.sink, json!({ "TurnResume": { "turn_id": turn_id } }), parent.as_deref());
        for event in events {
            emit(&self.sink, event, parent.as_deref());
        }
    }

    fn unsupported(&self, name: &str, id: &str) {
        eprintln!("cante-bridge: unsupported op {name}");
        self.error(&format!("这个版本还不支持这个操作：{name}"), Some(id));
    }

    fn error(&self, message: &str, parent: Option<&str>) {
        emit(&self.sink, json!({ "Error": message }), parent);
    }

    // -- pi child ------------------------------------------------------------

    fn cwd_path(&self) -> PathBuf {
        if let Some(cwd) = self.args.cwd.as_deref() {
            let path = PathBuf::from(cwd);
            if path.is_dir() {
                return path;
            }
        }
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    fn ensure_pi(&mut self, op_id: &str) -> Result<(), String> {
        if self.pi.is_some() {
            return Ok(());
        }
        let cwd = self.cwd_path();
        let program = pi_program();
        let extension = gate_extension_path()?;
        let args = pi_args(&self.args, Some(&extension));
        let mut command = Command::new(&program);
        command
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("没能把助手启动起来（{program}）：{error}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "没拿到助手的输入管道".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "没拿到助手的输出管道".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "没拿到助手的错误管道".to_string())?;
        let pi_stdin = Arc::new(Mutex::new(Some(stdin)));

        let (state_tx, state_rx) = mpsc::channel();
        self.state_rx = Some(state_rx);
        let ctx = ReaderCtx {
            sink: Arc::clone(&self.sink),
            shared: Arc::clone(&self.shared),
            state_tx,
            shutting_down: Arc::clone(&self.shutting_down),
            started: Arc::clone(&self.started),
            pi_stdin: Arc::clone(&pi_stdin),
        };
        thread::Builder::new()
            .name("cante-bridge-pi".to_string())
            .spawn(move || pi_reader(stdout, ctx))
            .map_err(|error| format!("没能开始读助手的输出：{error}"))?;
        thread::Builder::new()
            .name("cante-bridge-pi-log".to_string())
            .spawn(move || pi_log(stderr))
            .map_err(|error| format!("没能开始读助手的日志：{error}"))?;
        self.pi = Some(Pi { child, stdin: pi_stdin });

        let request_id = format!("state_{}", protocol::ulid());
        self.write_pi(&json!({ "id": request_id, "type": "get_state" }))?;
        let response = match self.state_rx.as_ref() {
            Some(rx) => rx.recv_timeout(STATE_TIMEOUT).ok(),
            None => None,
        };
        let data = response
            .as_ref()
            .filter(|response| response.get("success").and_then(Value::as_bool) == Some(true))
            .and_then(|response| response.get("data"))
            .cloned();
        let info = session_info(
            data.as_ref(),
            &cwd.to_string_lossy(),
            self.args.permission_mode.as_deref(),
        );
        // The context snapshot needs the model's window, and pi reports it in
        // the same `get_state`. `None` (no model, or no `contextWindow`) keeps
        // the snapshot out of every `UsageUpdate` instead of inventing one.
        lock(&self.shared).turn.context_limit = data
            .as_ref()
            .and_then(|data| data.get("model"))
            .and_then(|model| model.get("contextWindow"))
            .and_then(Value::as_u64)
            .and_then(|limit| u32::try_from(limit).ok())
            .filter(|limit| *limit > 0);
        emit(&self.sink, json!({ "SessionStart": info }), Some(op_id));
        self.started.store(true, Ordering::SeqCst);
        if data.is_none() {
            emit(
                &self.sink,
                json!({ "Info": "没拿到助手的自述信息，先按已知的默认值走" }),
                Some(op_id),
            );
        }
        Ok(())
    }

    fn write_pi(&self, value: &Value) -> Result<(), String> {
        let pi = self.pi.as_ref().ok_or_else(|| "助手还没启动".to_string())?;
        let mut guard = lock(&pi.stdin);
        let stdin = guard.as_mut().ok_or_else(|| "助手的输入管道已经关了".to_string())?;
        writeln!(stdin, "{value}").map_err(|error| format!("写给助手失败：{error}"))?;
        stdin.flush().map_err(|error| format!("写给助手失败：{error}"))
    }

    // -- shutdown ------------------------------------------------------------

    fn finish(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        emit(&self.sink, json!("Goodbye"), None);
        if let Some(pi) = self.pi.take() {
            close_pi_stdin(&pi.stdin);
            reap(pi.child);
        }
    }
}

/// Read `pi` stdout, translate events, and forward logs.
fn pi_reader(stdout: ChildStdout, ctx: ReaderCtx) {
    let mut reader = BufReader::new(stdout);
    let mut splitter = LineSplitter::default();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                for line in splitter.push(&buffer[..n]) {
                    handle_pi_line(&line, &ctx);
                }
            }
            Err(_) => break,
        }
    }
    if let Some(line) = splitter.finish() {
        handle_pi_line(&line, &ctx);
    }
    // `pi` closed its stdout. On the normal path `finish()` is already tearing
    // the session down; anything else means the child died under us, and the
    // desktop bridge has to see the pipe end so it can report `cante://exit`.
    if !ctx.shutting_down.load(Ordering::SeqCst) {
        let parent = lock(&ctx.shared).parent.clone();
        ctx.shutting_down.store(true, Ordering::SeqCst);
        close_pi_stdin(&ctx.pi_stdin);
        // Died before `SessionStart`? That is a startup failure the window has
        // to hear about, not a silent goodbye (a misconfigured provider exits
        // here). After startup, the turn events already told the story.
        if !ctx.started.load(Ordering::SeqCst) {
            emit(
                &ctx.sink,
                json!({ "Error": "助手没能启动起来，它一开始就退出了" }),
                parent.as_deref(),
            );
        }
        emit(&ctx.sink, json!("Goodbye"), parent.as_deref());
        std::process::exit(0);
    }
}

fn handle_pi_line(line: &str, ctx: &ReaderCtx) {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("cante-bridge: ignoring a non-JSON line from the assistant");
            return;
        }
    };
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "extension_ui_request" => {
            handle_ui_request(&value, ctx);
            return;
        }
        "response" => {
            if value.get("command").and_then(Value::as_str) == Some("get_state") {
                let _ = ctx.state_tx.send(value);
            }
            return;
        }
        _ => {}
    }
    let (parent, events) = {
        let mut shared = lock(&ctx.shared);
        let parent = shared.parent.clone();
        let events = translate(&value, &mut shared.turn);
        (parent, events)
    };
    for event in events {
        emit(&ctx.sink, event, parent.as_deref());
    }
}

/// A dialog from `pi`. Ours is the approval gate (`options[0]` is
/// [`GATE_MARKER`]); everything else keeps the fail-safe answer, because an
/// unknown dialog must not hang the turn and must not be answered "yes".
fn handle_ui_request(request: &Value, ctx: &ReaderCtx) {
    let id = request.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        return;
    }
    let gate = (request.get("method").and_then(Value::as_str) == Some("select"))
        .then(|| request.get("options").and_then(Value::as_array))
        .flatten()
        .filter(|options| options.first().and_then(Value::as_str) == Some(GATE_MARKER))
        .and_then(|options| options.get(1))
        .and_then(Value::as_str)
        .and_then(gate_tools);
    match gate {
        Some(tools) => open_gate(&id, &tools, ctx),
        None => match ui_response_for(request) {
            Some(response) => {
                let _ = write_pi_stdin(&ctx.pi_stdin, &response);
            }
            None => eprintln!("cante-bridge: ignoring a fire-and-forget UI request"),
        },
    }
}

/// Parse the gate extension's batch payload (`options[1]`). `None` means the
/// payload was not readable — the caller then answers all-deny.
fn gate_tools(text: &str) -> Option<Vec<Value>> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let tools: Vec<Value> = value
        .get("tools")?
        .as_array()?
        .iter()
        .filter_map(|tool| {
            let id = tool_id(tool);
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "name": tool_name(tool),
                "args": tool.get("args").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();
    if tools.is_empty() {
        None
    } else {
        Some(tools)
    }
}

/// Split a batch into the calls already covered by "allow from now on" and the
/// ones the window still has to decide.
fn partition_allowed(tools: &[Value], always_allowed: &HashSet<String>) -> (Vec<String>, Vec<Value>) {
    let mut auto = Vec::new();
    let mut ask = Vec::new();
    for tool in tools {
        if always_allowed.contains(tool_name(tool)) {
            auto.push(tool_id(tool).to_string());
        } else {
            ask.push(tool.clone());
        }
    }
    (auto, ask)
}

/// How one `ApprovalResponse` resolves a paused batch.
#[derive(Debug, PartialEq)]
struct GatePlan {
    allow: Vec<String>,
    deny: Vec<String>,
    reason: String,
    /// Tool names to remember for the rest of this bridge process
    /// (`AcceptForSession` / `AcceptAlways`).
    remember: Vec<String>,
}

/// Turn the window's per-call decisions into one plan. A call the window did
/// not answer for is denied: a missing decision must never become a permission.
fn plan_gate(tools: &[Value], responses: &[Value]) -> GatePlan {
    let mut plan = GatePlan { allow: Vec::new(), deny: Vec::new(), reason: String::new(), remember: Vec::new() };
    for tool in tools {
        let id = tool_id(tool).to_string();
        let answer = responses
            .iter()
            .find(|response| response.get("tool_use_id").and_then(Value::as_str) == Some(id.as_str()));
        let decision = answer
            .and_then(|response| response.get("decision"))
            .and_then(Value::as_str)
            .unwrap_or("Deny");
        if matches!(decision, "AcceptForSession" | "AcceptAlways") {
            plan.remember.push(tool_name(tool).to_string());
        }
        if let Some(text) = answer
            .and_then(|response| response.get("message"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() && plan.reason.is_empty() {
                plan.reason = text.to_string();
            }
        }
        if matches!(decision, "Accept" | "AcceptForSession" | "AcceptAlways") {
            plan.allow.push(id);
        } else {
            plan.deny.push(id);
        }
    }
    if plan.reason.is_empty() {
        plan.reason = DEFAULT_DENY_REASON.to_string();
    }
    plan
}

/// Open an approval pause for one batch.
fn open_gate(request_id: &str, tools: &[Value], ctx: &ReaderCtx) {
    let (turn_id, parent, auto_allowed, ask) = {
        let mut shared = lock(&ctx.shared);
        let turn_id = shared.turn.current_turn_id();
        let parent = shared.parent.clone();
        // "Allow from now on" is remembered by tool name, for this bridge
        // process only (see BRIDGE-gate.md for what that does and does not buy).
        let (auto_allowed, ask) = partition_allowed(tools, &shared.always_allowed);
        if !ask.is_empty() {
            shared.turn.gate = Some(PendingGate {
                turn_id: turn_id.clone(),
                request_id: request_id.to_string(),
                tools: ask.clone(),
            });
        }
        (turn_id, parent, auto_allowed, ask)
    };

    if ask.is_empty() {
        // Nothing left to ask: answer the extension at once and let the held
        // starts out. No `TurnPause`/`TurnResume` pair, because the window
        // never saw a question.
        let encoded = json!({ "v": 1, "allow": auto_allowed, "deny": [], "reason": "" }).to_string();
        let response = json!({ "type": "extension_ui_response", "id": request_id, "value": encoded });
        let _ = write_pi_stdin(&ctx.pi_stdin, &response);
        let released = {
            let mut shared = lock(&ctx.shared);
            let mut out = Vec::new();
            for id in &auto_allowed {
                out.extend(shared.turn.decide(id, true));
            }
            out
        };
        for event in released {
            emit(&ctx.sink, event, parent.as_deref());
        }
        return;
    }

    // The message is deliberately empty: the sheet already says "它想先做 N 件事，
    // 需要你点头" from the tool count, so anything here would only repeat it.
    let pause = json!({
        "TurnPause": {
            "turn_id": turn_id,
            "reason": { "Approval": { "tools": ask, "message": "" } },
        }
    });
    emit(&ctx.sink, pause, parent.as_deref());
}

/// Forward `pi`'s stderr verbatim: `daemon.rs` turns those lines into
/// `cante://log`, and the probe measured pi's stderr as clean.
fn pi_log(stderr: impl Read) {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        eprintln!("{line}");
    }
}

fn write_pi_stdin(stdin: &Arc<Mutex<Option<ChildStdin>>>, value: &Value) -> Result<(), String> {
    let mut guard = lock(stdin);
    let stdin = guard.as_mut().ok_or_else(|| "assistant stdin is closed".to_string())?;
    writeln!(stdin, "{value}").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn emit(sink: &Sink, event: Value, parent: Option<&str>) {
    let frame = json!({
        "timestamp": now_iso8601(),
        "id": format!("evt_{}", protocol::ulid()),
        "event": event,
        "parent": parent,
    });
    let mut out = lock(sink);
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}

// ---------------------------------------------------------------------------
// Tests: translation only — the end-to-end run lives in `tests/bridge.rs`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn deltas(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| event.get("MessageDelta").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    fn turn_ends(events: &[Value]) -> Vec<Value> {
        events
            .iter()
            .filter_map(|event| event.get("TurnEnd").cloned())
            .collect()
    }

    #[test]
    fn agent_start_opens_a_turn_and_agent_settled_closes_it() {
        let mut state = TurnState::default();
        let started = translate(&json!({ "type": "agent_start" }), &mut state);
        let turn_id = started[0]["TurnStart"]["turn_id"].as_str().unwrap().to_string();
        assert!(turn_id.starts_with("turn_"));

        // A continuation reports `agent_start` again; it must not open a
        // second turn with a new id.
        assert!(
            translate(&json!({ "type": "agent_start" }), &mut state).is_empty(),
            "a repeated agent_start must not open a new turn"
        );

        // A tool-calling prompt makes two assistant replies; neither may end
        // the user turn on its own.
        translate(&json!({ "type": "turn_start" }), &mut state);
        let mid = translate(
            &json!({ "type": "turn_end", "message": { "role": "assistant", "stopReason": "toolUse" } }),
            &mut state,
        );
        assert!(turn_ends(&mid).is_empty(), "turn_end must not emit TurnEnd");
        translate(&json!({ "type": "turn_start" }), &mut state);

        let settled = translate(
            &json!({ "type": "agent_settled" }),
            &mut state,
        );
        let ends = turn_ends(&settled);
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0]["turn_id"], json!(turn_id));
        assert_eq!(ends[0]["status"], json!("Completed"));
        assert_eq!(ends[0]["steps"], json!(2));
    }

    #[test]
    fn text_deltas_and_the_final_message_keep_their_order() {
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        let first = translate(
            &json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "我先看一下" } }),
            &mut state,
        );
        let thinking = translate(
            &json!({ "type": "message_update", "assistantMessageEvent": { "type": "thinking_delta", "delta": "嗯" } }),
            &mut state,
        );
        let second = translate(
            &json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "，然后用工具。" } }),
            &mut state,
        );
        assert_eq!(deltas(&first), vec!["我先看一下"]);
        assert_eq!(thinking, vec![json!({ "ThinkingDelta": "嗯" })]);
        assert_eq!(deltas(&second), vec!["，然后用工具。"]);

        let end = translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "我先看一下" },
                    { "type": "toolCall", "id": "call_1", "name": "bash", "arguments": {} }
                ],
                "stopReason": "toolUse",
            }}),
            &mut state,
        );
        assert_eq!(end, vec![json!({ "AgentMessage": "我先看一下" })]);
    }

    #[test]
    fn the_user_echo_is_not_an_agent_message() {
        let mut state = TurnState::default();
        let out = translate(
            &json!({ "type": "message_end", "message": { "role": "user", "content": "把这件事做了" } }),
            &mut state,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn a_reported_response_becomes_a_cache_inclusive_usage_update() {
        let mut state = TurnState { context_limit: Some(200_000), ..TurnState::default() };
        let out = translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "好了" }],
                "stopReason": "stop",
                // pi's own counters: `input` is net of the cache buckets, and
                // totalTokens is their sum (`pi 0.85.1`, measured live).
                "usage": { "input": 80, "output": 20, "cacheRead": 100, "cacheWrite": 5, "totalTokens": 205 },
            }}),
            &mut state,
        );
        assert_eq!(out[0], json!({ "AgentMessage": "好了" }));
        assert_eq!(out[1], json!({ "UsageUpdate": {
            "usage": {
                "input_tokens": 185,
                "output_tokens": 20,
                "cache_read_tokens": 100,
                "cache_creation_tokens": 5,
            },
            "context": { "used_tokens": 205, "limit_tokens": 200_000 },
        }}));
    }

    #[test]
    fn an_unreported_usage_is_never_invented() {
        let mut state = TurnState { context_limit: Some(200_000), ..TurnState::default() };
        // pi leaves `usage` all-zero when the provider sends none (PROBE §3 C):
        // that is "no measurement", so no `UsageUpdate` may claim zero tokens.
        let empty = translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant", "content": [{ "type": "text", "text": "这是" }],
                "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            }}),
            &mut state,
        );
        assert_eq!(empty, vec![json!({ "AgentMessage": "这是" })]);
        // No `usage` key at all is the same thing.
        let missing = translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant", "content": [{ "type": "text", "text": "这是" }],
            }}),
            &mut state,
        );
        assert_eq!(missing, vec![json!({ "AgentMessage": "这是" })]);
    }

    #[test]
    fn context_needs_a_limit_and_tool_only_replies_still_report_usage() {
        // No `get_state` yet, so no window is known.
        let mut state = TurnState::default();
        let out = translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant",
                "content": [{ "type": "toolCall", "id": "call_1", "name": "bash", "arguments": {} }],
                "stopReason": "toolUse",
                "usage": { "input": 30, "output": 4, "cacheRead": 0, "cacheWrite": 0 },
            }}),
            &mut state,
        );
        assert_eq!(out.len(), 1, "a tool-call-only reply has no text to send");
        let update = &out[0]["UsageUpdate"];
        assert_eq!(update["usage"]["input_tokens"], json!(30));
        assert_eq!(update["usage"]["output_tokens"], json!(4));
        assert!(update.get("context").is_none(), "an unknown window must not be invented");
    }

    #[test]
    fn compaction_reports_the_summary_call_it_paid_for() {
        let mut state = TurnState { context_limit: Some(32_000), ..TurnState::default() };
        let out = translate(
            &json!({ "type": "compaction_end", "result": {
                "summary": "短一点",
                "usage": { "input": 3_000, "output": 200, "cacheRead": 0, "cacheWrite": 0 },
            }}),
            &mut state,
        );
        assert_eq!(out[0], json!({ "CompactEnd": { "summary": "短一点" } }));
        assert_eq!(out[1]["UsageUpdate"]["usage"]["input_tokens"], json!(3_000));
        assert_eq!(out[1]["UsageUpdate"]["context"]["used_tokens"], json!(3_200));
    }

    #[test]
    fn tool_updates_carry_only_the_new_text() {
        let mut state = TurnState::default();
        let start = translate(
            &json!({ "type": "tool_execution_start", "toolCallId": "call_1", "toolName": "bash", "args": { "command": "ls" } }),
            &mut state,
        );
        // Held until the gate decides: `tool_execution_start` fires before the
        // approval hook (PROBE §3 B).
        assert!(start.is_empty(), "a ToolStart must not go out while the sheet may still open");

        // An update proves no gate is holding this call, so the held start is
        // released immediately before the delta.
        let first = translate(
            &json!({ "type": "tool_execution_update", "toolCallId": "call_1",
                "partialResult": { "content": [{ "type": "text", "text": "a\n" }] } }),
            &mut state,
        );
        assert_eq!(first, vec![
            json!({ "ToolStart": { "id": "call_1", "name": "bash", "args": { "command": "ls" } } }),
            json!({ "ToolUpdate": { "tool_use_id": "call_1", "seq": 1, "message": "a\n" } }),
        ]);

        // pi resends the accumulated output; only the suffix may be appended.
        let second = translate(
            &json!({ "type": "tool_execution_update", "toolCallId": "call_1",
                "partialResult": { "content": [{ "type": "text", "text": "a\nb\n" }] } }),
            &mut state,
        );
        assert_eq!(second, vec![json!({ "ToolUpdate": { "tool_use_id": "call_1", "seq": 2, "message": "b\n" } })]);

        let third = translate(
            &json!({ "type": "tool_execution_update", "toolCallId": "call_1",
                "partialResult": { "content": [{ "type": "text", "text": "a\nb\n" }] } }),
            &mut state,
        );
        assert!(third.is_empty(), "an unchanged cumulative update adds nothing");
    }

    fn tool_start_event(id: &str, name: &str) -> Value {
        json!({ "type": "tool_execution_start", "toolCallId": id, "toolName": name, "args": {} })
    }

    #[test]
    fn an_allowed_call_releases_its_held_tool_start() {
        let mut state = TurnState::default();
        assert!(translate(&tool_start_event("call_1", "bash"), &mut state).is_empty());
        let released = state.decide("call_1", true);
        assert_eq!(released, vec![json!({ "ToolStart": { "id": "call_1", "name": "bash", "args": {} } })]);
        assert!(state.decide("call_1", true).is_empty(), "a decision is applied once");
    }

    #[test]
    fn a_denied_call_is_closed_without_running_and_its_result_is_swallowed() {
        let mut state = TurnState::default();
        translate(&tool_start_event("call_1", "bash"), &mut state);
        state.deny_reason = "不要".to_string();
        let released = state.decide("call_1", false);
        assert_eq!(released[0]["ToolStart"], json!({ "id": "call_1", "name": "bash", "args": {} }));
        assert_eq!(released[1]["ToolEnd"]["status"], json!("Denied"));
        assert_eq!(released[1]["ToolEnd"]["result_json"]["content"][0]["text"], json!("不要"));

        // pi still sends the blocked call's (error) result; it must not become
        // a second ToolEnd for the same id.
        let after = translate(
            &json!({ "type": "tool_execution_end", "toolCallId": "call_1", "toolName": "bash",
                "result": { "content": [{ "type": "text", "text": "用户拒绝" }] }, "isError": true }),
            &mut state,
        );
        assert!(after.is_empty(), "the denied call's own result must be dropped");
    }

    #[test]
    fn a_decision_that_arrives_before_the_start_still_closes_a_denied_call() {
        let mut state = TurnState::default();
        state.deny_reason = "不要".to_string();
        assert!(state.decide("call_2", false).is_empty());
        let started = translate(&tool_start_event("call_2", "write"), &mut state);
        assert_eq!(started[0]["ToolStart"]["name"], json!("write"));
        assert_eq!(started[1]["ToolEnd"]["status"], json!("Denied"));
    }

    #[test]
    fn a_turn_that_settles_while_paused_closes_the_held_start() {
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        translate(&tool_start_event("call_1", "bash"), &mut state);
        // The user pressed stop with the approval sheet open: pi aborts, the
        // dialog resolves as denied, but no ApprovalResponse ever arrives.
        state.requested_abort = true;
        let settled = translate(&json!({ "type": "agent_settled" }), &mut state);
        assert_eq!(settled[0]["ToolStart"]["id"], json!("call_1"));
        assert_eq!(settled[1]["ToolEnd"]["status"], json!("Cancelled"));
        assert_eq!(settled[2]["TurnEnd"]["status"], json!({ "Interrupted": { "reason": "user" } }));
    }

    #[test]
    fn gate_tools_only_accepts_the_marked_payload() {
        let payload = json!({ "v": 1, "tools": [
            { "id": "call_1", "name": "bash", "args": { "command": "rm -rf /" } },
            { "id": "", "name": "ignored" },
        ] })
        .to_string();
        let tools = gate_tools(&payload).expect("a marked payload parses");
        assert_eq!(tools.len(), 1, "tools without an id cannot be answered");
        assert_eq!(tools[0]["id"], json!("call_1"));
        assert_eq!(tools[0]["args"]["command"], json!("rm -rf /"));

        assert!(gate_tools("not json").is_none());
        assert!(gate_tools(&json!({ "v": 2, "tools": [] }).to_string()).is_none());
        assert!(gate_tools(&json!({ "v": 1, "tools": [{ "name": "bash" }] }).to_string()).is_none());
    }

    #[test]
    fn tool_end_maps_is_error_to_failed() {
        let mut state = TurnState::default();
        let out = translate(
            &json!({ "type": "tool_execution_end", "toolCallId": "call_1", "toolName": "bash",
                "result": { "content": [{ "type": "text", "text": "boom" }] }, "isError": true }),
            &mut state,
        );
        assert_eq!(out[0]["ToolEnd"]["status"], json!("Failed"));
        assert_eq!(out[0]["ToolEnd"]["tool_name"], json!("bash"));
    }

    #[test]
    fn an_aborted_turn_ends_as_interrupted() {
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant", "content": [{ "type": "text", "text": "这是" }],
                "stopReason": "aborted", "errorMessage": "Request was aborted",
            }}),
            &mut state,
        );
        let ends = turn_ends(&translate(&json!({ "type": "agent_settled" }), &mut state));
        assert_eq!(ends[0]["status"], json!({ "Interrupted": { "reason": "user" } }));
    }

    #[test]
    fn an_error_turn_keeps_the_message() {
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant", "content": [],
                "stopReason": "error", "errorMessage": "529 overloaded",
            }}),
            &mut state,
        );
        let ends = turn_ends(&translate(&json!({ "type": "agent_settled" }), &mut state));
        assert_eq!(ends[0]["status"], json!({ "Error": { "headline": "529 overloaded" } }));
    }

    #[test]
    fn requesting_a_stop_is_enough_even_without_a_stop_reason() {
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        state.requested_abort = true;
        let ends = turn_ends(&translate(&json!({ "type": "agent_settled" }), &mut state));
        assert_eq!(ends[0]["status"], json!({ "Interrupted": { "reason": "user" } }));
    }

    #[test]
    fn a_requested_stop_beats_an_abort_error() {
        // Aborting a tool preflight parked in the approval hook comes back as
        // stopReason "error" / "This operation was aborted". The user pressed
        // Stop, so the turn reads as interrupted, not as a failure.
        let mut state = TurnState::default();
        translate(&json!({ "type": "agent_start" }), &mut state);
        translate(
            &json!({ "type": "message_end", "message": {
                "role": "assistant", "content": [],
                "stopReason": "error", "errorMessage": "This operation was aborted",
            }}),
            &mut state,
        );
        state.requested_abort = true;
        let ends = turn_ends(&translate(&json!({ "type": "agent_settled" }), &mut state));
        assert_eq!(ends[0]["status"], json!({ "Interrupted": { "reason": "user" } }));
    }

    #[test]
    fn a_plan_denies_anything_the_window_did_not_answer_for() {
        let tools = vec![
            json!({ "id": "a", "name": "read", "args": {} }),
            json!({ "id": "b", "name": "bash", "args": {} }),
        ];
        // A response set that is missing "b" (or uses an unknown decision) must
        // not turn into a permission to run it.
        let plan = plan_gate(&tools, &[json!({ "tool_use_id": "a", "decision": "Accept" })]);
        assert_eq!(plan.allow, vec!["a".to_string()]);
        assert_eq!(plan.deny, vec!["b".to_string()]);
        assert_eq!(plan.reason, DEFAULT_DENY_REASON);
        assert!(plan.remember.is_empty());

        // "Allow from now on" is remembered by tool name; the deny message is
        // carried through to the model.
        let plan = plan_gate(
            &tools,
            &[
                json!({ "tool_use_id": "a", "decision": "AcceptAlways" }),
                json!({ "tool_use_id": "b", "decision": "Deny", "message": "不能删" }),
            ],
        );
        assert_eq!(plan.allow, vec!["a".to_string()]);
        assert_eq!(plan.deny, vec!["b".to_string()]);
        assert_eq!(plan.remember, vec!["read".to_string()]);
        assert_eq!(plan.reason, "不能删");
    }

    #[test]
    fn only_tools_the_user_allowed_for_this_session_skip_the_question() {
        let tools = vec![
            json!({ "id": "a", "name": "read", "args": {} }),
            json!({ "id": "b", "name": "bash", "args": {} }),
        ];
        let always: HashSet<String> = ["read".to_string()].into_iter().collect();
        let (auto, ask) = partition_allowed(&tools, &always);
        assert_eq!(auto, vec!["a".to_string()]);
        assert_eq!(ask.len(), 1);
        assert_eq!(ask[0]["id"], json!("b"));

        // Nothing remembered: the whole batch is asked about.
        let (auto, ask) = partition_allowed(&tools, &HashSet::new());
        assert!(auto.is_empty());
        assert_eq!(ask.len(), 2);
    }

    #[test]
    fn session_info_reads_the_state_response_verbatim() {
        let state = json!({
            "model": {
                "id": "probe-model",
                "name": "Probe Model",
                "provider": "probe",
                "baseUrl": "http://127.0.0.1:1/v1",
                "input": ["text", "image"],
            },
            "sessionId": "session-1",
        });
        let info = session_info(Some(&state), "/tmp/work", Some("auto"));
        assert_eq!(info["session_id"], json!("session-1"));
        assert_eq!(info["model"]["id"], json!("probe-model"));
        assert_eq!(info["model"]["display_name"], json!("Probe Model"));
        assert_eq!(info["model"]["support_vision"], json!(true));
        assert_eq!(info["provider"]["id"], json!("probe"));
        assert_eq!(info["provider"]["base_url"], json!("http://127.0.0.1:1/v1"));
        assert_eq!(info["provider"]["display_name"], json!(""));
        assert_eq!(info["permission_mode"], json!("Auto"));
        assert_eq!(info["cwd"], json!("/tmp/work"));
        assert_eq!(info["skills"], json!([]));
        assert_eq!(info["title"], Value::Null);
    }

    #[test]
    fn missing_state_leaves_the_session_fields_empty_not_invented() {
        let info = session_info(None, "/tmp/work", Some("strict"));
        assert_eq!(info["session_id"], json!(""));
        assert_eq!(info["model"], json!({ "id": "" }));
        assert_eq!(info["provider"]["id"], json!(""));
        assert_eq!(info["provider"]["base_url"], json!(""));
        assert_eq!(info["permission_mode"], json!("Strict"));
        // No `support_vision` at all: "pi did not say", never `false` or `true`.
        assert!(info["model"].get("support_vision").is_none());
    }

    #[test]
    fn permission_modes_fold_to_the_wire_values() {
        assert_eq!(permission_mode_wire(Some("strict")), "Strict");
        assert_eq!(permission_mode_wire(Some("Auto")), "Auto");
        assert_eq!(permission_mode_wire(Some("yolo")), "Yolo");
        assert_eq!(permission_mode_wire(None), "Auto");
        assert_eq!(permission_mode_wire(Some("nonsense")), "Auto");
    }

    #[test]
    fn pi_args_carry_mode_and_the_optional_model() {
        assert_eq!(pi_args(&StartArgs::default(), None), vec!["--mode", "rpc", "--no-session"]);
        let args = StartArgs {
            model: Some("probe-model".to_string()),
            provider: Some("probe".to_string()),
            permission_mode: None,
            cwd: None,
        };
        assert_eq!(
            pi_args(&args, None),
            vec!["--mode", "rpc", "--no-session", "--provider", "probe", "--model", "probe-model"]
        );
        // The approval gate is loaded through `-e`, before provider/model.
        assert_eq!(
            pi_args(&args, Some(Path::new("/tmp/gate.ts"))),
            vec!["--mode", "rpc", "--no-session", "-e", "/tmp/gate.ts", "--provider", "probe", "--model", "probe-model"]
        );
    }

    #[test]
    fn the_gate_extension_is_materialized_with_its_marker() {
        let path = gate_extension_path().expect("write the gate extension");
        let written = std::fs::read_to_string(&path).expect("read it back");
        assert_eq!(written, GATE_EXTENSION);
        assert!(written.contains(GATE_MARKER), "the extension must speak the adapter's marker");
        // Calling again reuses the same content-addressed file.
        assert_eq!(gate_extension_path().expect("reuse it"), path);
    }

    /// A file with the wrong bytes is exactly what a Windows `rename` refuses to
    /// overwrite, so this is the case that used to wedge every later session
    /// there. Uses its own directory: the shared content-addressed path belongs
    /// to every other test in this file.
    #[test]
    fn a_stale_gate_file_is_replaced_not_blamed() {
        let dir = std::env::temp_dir().join(format!(
            "cante-gate-stale-{}-{}",
            std::process::id(),
            protocol::ulid()
        ));
        std::fs::create_dir_all(&dir).expect("make the scratch dir");
        let path = dir.join("gate.ts");
        std::fs::write(&path, "an older bridge left this here").expect("seed the stale file");

        materialize(&path, GATE_EXTENSION).expect("replace the stale file");
        assert_eq!(std::fs::read_to_string(&path).expect("read it back"), GATE_EXTENSION);

        // And once it is right, the next call is a no-op that leaves no scratch.
        materialize(&path, GATE_EXTENSION).expect("reuse the file");
        assert_eq!(std::fs::read_to_string(&path).expect("read it back"), GATE_EXTENSION);
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("list the dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "scratch files were left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn materialize_writes_the_gate_file_when_the_directory_is_empty() {
        let dir = std::env::temp_dir().join(format!(
            "cante-gate-empty-{}-{}",
            std::process::id(),
            protocol::ulid()
        ));
        std::fs::create_dir_all(&dir).expect("make the scratch dir");
        let path = dir.join("gate.ts");
        materialize(&path, GATE_EXTENSION).expect("write the file");
        assert_eq!(std::fs::read_to_string(&path).expect("read it back"), GATE_EXTENSION);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dialogs_are_cancelled_and_notifications_are_ignored() {
        let dialog = json!({ "type": "extension_ui_request", "id": "u1", "method": "select" });
        assert_eq!(
            ui_response_for(&dialog),
            Some(json!({ "type": "extension_ui_response", "id": "u1", "cancelled": true }))
        );
        let notify = json!({ "type": "extension_ui_request", "id": "u2", "method": "notify" });
        assert_eq!(ui_response_for(&notify), None);
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(iso8601_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }
}
