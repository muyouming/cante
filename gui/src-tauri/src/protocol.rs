//! Wire helpers for the Cante `Op`/`Evt` protocol.
//!
//! The daemon's events are forwarded as opaque [`serde_json::Value`]s; typed
//! interpretation lives in the frontend (`src/protocol.ts`). This module holds
//! only what the Rust half genuinely needs: JSONL framing, locally minted
//! `op_<ULID>` ids, and the state reduction the contract freezes.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// JSONL framing
// ---------------------------------------------------------------------------

/// Incremental line splitter.
///
/// Chunk boundaries land anywhere — including inside a multi-byte UTF-8
/// sequence — so the pending buffer is kept as bytes and only decoded once a
/// whole line is available.
#[derive(Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
}

impl LineSplitter {
    /// Feed a chunk; return every complete, non-blank, trimmed line it produced.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0usize;
        for i in 0..self.pending.len() {
            if self.pending[i] == b'\n' {
                if let Some(line) = decode_line(&self.pending[start..i]) {
                    out.push(line);
                }
                start = i + 1;
            }
        }
        if start > 0 {
            self.pending.drain(..start);
        }
        out
    }

    /// Flush a trailing line that arrived without a terminating newline.
    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let line = decode_line(&self.pending);
        self.pending.clear();
        line
    }
}

fn decode_line(bytes: &[u8]) -> Option<String> {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Ids — Cante ids are `{prefix}_{ULID}`, so we mint real ULIDs locally.
// ---------------------------------------------------------------------------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_CHARS: usize = 10;
const ULID_RANDOM_CHARS: usize = 16;

/// Encode a 48-bit millisecond timestamp as ten Crockford base32 characters.
pub fn encode_time(ms: u64) -> String {
    let mut value = ms & 0xFFFF_FFFF_FFFF;
    let mut out = [0u8; ULID_TIME_CHARS];
    for i in (0..ULID_TIME_CHARS).rev() {
        out[i] = CROCKFORD[(value & 31) as usize];
        value >>= 5;
    }
    // Every byte comes from the ASCII alphabet above.
    String::from_utf8(out.to_vec()).expect("crockford alphabet is ASCII")
}

/// Build a 26-character ULID from an explicit timestamp and entropy.
pub fn ulid_from(ms: u64, entropy: &[u8; ULID_RANDOM_CHARS]) -> String {
    let mut out = encode_time(ms);
    for byte in entropy {
        out.push(CROCKFORD[(byte & 31) as usize] as char);
    }
    out
}

/// A fresh, spec-shaped ULID (48-bit ms timestamp + 80 bits of entropy).
pub fn ulid() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    ulid_from(ms, &entropy())
}

/// `op_<ULID>` — the id stamped on every operation we send.
pub fn op_id() -> String {
    format!("op_{}", ulid())
}

static ENTROPY_COUNTER: AtomicU64 = AtomicU64::new(0);

fn entropy() -> [u8; ULID_RANDOM_CHARS] {
    let mut bytes = [0u8; ULID_RANDOM_CHARS];
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
            if file.read_exact(&mut bytes).is_ok() {
                return bytes;
            }
        }
    }
    // Fallback for hosts without /dev/urandom: splitmix64 seeded from the
    // clock, a per-process counter, and the hasher's random state.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = ENTROPY_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut x = now ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut extra = RandomState::new().build_hasher();
    extra.write_u64(now);
    extra.write_u64(counter);
    x ^= extra.finish();
    for chunk in bytes.chunks_mut(8) {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let le = z.to_le_bytes();
        let n = chunk.len();
        chunk.copy_from_slice(&le[..n]);
    }
    bytes
}

// ---------------------------------------------------------------------------
// Event accessors
// ---------------------------------------------------------------------------

/// The externally-tagged variant name of an `Evt` (unit variants are strings).
pub fn event_name(event: &Value) -> &str {
    match event {
        Value::String(name) => name.as_str(),
        Value::Object(map) => map.keys().next().map(String::as_str).unwrap_or("Unknown"),
        _ => "Unknown",
    }
}

/// The payload carried by a struct variant, if present.
pub fn event_payload<'a>(event: &'a Value, name: &str) -> Option<&'a Value> {
    event.as_object().and_then(|map| map.get(name))
}

/// The string body of a newtype variant (`AgentMessage("…")`), if present.
pub fn text_of(event: &Value, name: &str) -> String {
    match event_payload(event, name) {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// State reduction — mirrors the contract's status transition table.
// ---------------------------------------------------------------------------

/// The bridge's advertised daemon state.
#[derive(Debug, Clone)]
pub struct CanteState {
    pub status: String,
    pub session: Option<Value>,
    pub pending_approval: Option<Value>,
}

impl Default for CanteState {
    fn default() -> Self {
        Self { status: "idle".to_string(), session: None, pending_approval: None }
    }
}

impl CanteState {
    /// The full state payload shared by `events_since` and `cante://state`.
    pub fn to_value(&self, cante: Option<&str>, cwd: &str) -> Value {
        json!({
            "status": self.status,
            "session": self.session,
            "pending_approval": self.pending_approval,
            "cante": cante,
            "cwd": cwd,
        })
    }
}

/// Fold one daemon event into the advertised state.
pub fn reduce_state(state: &mut CanteState, event: &Value) {
    let name = event_name(event);
    match name {
        "SessionStart" | "SessionUpdated" => {
            state.session = event_payload(event, name).cloned();
            state.pending_approval = None;
            state.status = "idle".to_string();
        }
        "SessionEnd" | "Goodbye" => {
            state.session = None;
            state.pending_approval = None;
            state.status = "offline".to_string();
        }
        "TurnStart" => {
            state.status = "thinking".to_string();
            state.pending_approval = None;
        }
        "Thinking" | "ThinkingDelta" => {
            if state.status != "awaiting" {
                state.status = "thinking".to_string();
            }
        }
        "AgentMessage" | "MessageDelta" | "ToolStart" | "ToolUpdate" | "ToolEnd" => {
            if state.status != "awaiting" {
                state.status = "streaming".to_string();
            }
        }
        "TurnPause" => {
            if let Some(payload) = event_payload(event, "TurnPause") {
                if let Some(approval) = payload.get("reason").and_then(|reason| reason.get("Approval")) {
                    state.status = "awaiting".to_string();
                    state.pending_approval = Some(pending_approval(payload, approval));
                }
            }
        }
        "TurnResume" => {
            state.status = "streaming".to_string();
            state.pending_approval = None;
        }
        "TurnEnd" => {
            if state.status != "error" {
                state.status = "idle".to_string();
            }
            state.pending_approval = None;
        }
        "Error" => {
            state.status = "error".to_string();
        }
        _ => {}
    }
}

fn pending_approval(payload: &Value, approval: &Value) -> Value {
    let turn_id = payload.get("turn_id").and_then(Value::as_str).unwrap_or("").to_string();
    let message = approval.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let tools = approval
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "id": tool.get("id").and_then(Value::as_str).unwrap_or(""),
                        "name": tool.get("name").and_then(Value::as_str).unwrap_or(""),
                        "args": tool.get("args").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({ "turn_id": turn_id, "message": message, "tools": tools })
}
