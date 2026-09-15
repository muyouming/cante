//! End-to-end soak: drive the real [`Daemon`] against a fast, large stream.
//!
//! `gui/fixtures/flood.ts` is a `cante serve` double that emits a configurable
//! number of events as fast as the pipe allows, including one multi-megabyte
//! `MessageDelta`, interleaved event kinds, and a final `TurnEnd`. This test
//! runs it through the real bridge over real pipes and asserts the properties a
//! fast stream can break:
//!
//! * every event arrives exactly once, in order;
//! * `events_since` pages stay contiguous and cursor-consistent even while the
//!   ring wraps underneath them;
//! * the ring stays bounded at `RING_CAPACITY` (the memory bound) and retains
//!   only the tail of the stream;
//! * the large line is framed intact (byte length preserved);
//! * the reduced state ends where the scripted stream implies;
//! * the reader keeps up — a throughput floor calibrated so the quadratic
//!   splitter from the previous round would fail loudly.
//!
//! The fixture is driven as `bun <script> serve` via `CANTE_BIN`'s command-spec
//! form (`Daemon::with_config`), which is also the only form that works on
//! Windows. No test body is `#[cfg(unix)]`.

use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;

use cante_gui_lib::daemon::{Daemon, Emitter, StartSessionArgs, RING_CAPACITY};

/// Total frames the fixture emits, including `SessionStart` and `TurnEnd`.
const FLOOD_EVENTS: u64 = 24_000;
/// Byte length of the one oversized `MessageDelta` payload.
const BIG_BYTES: usize = 12 * 1024 * 1024;
/// Sequence number (1-based) that carries the oversized payload.
const BIG_AT: u64 = 12_000;
/// How often the soak re-reads `events_since` while the flood is running.
const PAGE_EVERY: u64 = 512;
/// Generous floor: the fixture must frame the big line at least this fast.
/// Linear framing is 1-2 orders of magnitude quicker; a quadratic rescan of a
/// 12 MiB line falls well below this.
const MIN_BIG_MIB_PER_SEC: f64 = 2.0;
/// Generous floor for the overall stream.
const MIN_EVENTS_PER_SEC: f64 = 500.0;
/// Hard stop so a wedged reader fails the test instead of hanging CI forever.
const SOAK_TIMEOUT: Duration = Duration::from_secs(180);

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

/// The fixture's `evt_flood_<n>` sequence number.
fn seq_of(event: &Value) -> Option<u64> {
    event.get("id")?.as_str()?.strip_prefix("evt_flood_")?.parse().ok()
}

/// Read one `events_since` page and assert every cursor invariant it promises.
///
/// Returns the new head so the caller can page forward. The ring may wrap
/// between calls, which is exactly the transition this pins down.
fn check_page(daemon: &Daemon, cursor: u64) -> u64 {
    let page = daemon.events_since(cursor);
    let head = page["cursor"].as_u64().expect("cursor is a number");
    let truncated = page["truncated"].as_bool().expect("truncated is a bool");
    let events = page["events"].as_array().expect("events is an array");

    assert!(head >= cursor, "the ring cursor must never go backwards");
    assert!(
        events.len() <= RING_CAPACITY,
        "events_since served {} events, past the {RING_CAPACITY} ring bound",
        events.len()
    );

    if events.is_empty() {
        assert!(truncated || cursor >= head, "an empty page is only valid at the head");
        return head;
    }

    let first = seq_of(&events[0]).expect("the first served event has a flood id");
    let last = seq_of(events.last().unwrap()).expect("the last served event has a flood id");
    assert_eq!(last, head, "the newest served event must be the head");
    assert_eq!(
        last - first + 1,
        events.len() as u64,
        "a page must be a contiguous run with no gaps"
    );
    if truncated {
        assert_eq!(events.len(), RING_CAPACITY, "a truncated page serves exactly the whole ring");
    } else {
        assert_eq!(
            first,
            cursor + 1,
            "a page that did not fall off the front starts exactly at the cursor"
        );
    }
    head
}

#[test]
fn a_fast_large_stream_stays_ordered_bounded_and_consistent() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/flood.ts");
    assert!(fixture.exists(), "fixture missing: {}", fixture.display());

    std::env::set_var("CANTE_FLOOD_EVENTS", FLOOD_EVENTS.to_string());
    std::env::set_var("CANTE_FLOOD_BIG_BYTES", BIG_BYTES.to_string());
    std::env::set_var("CANTE_FLOOD_BIG_AT", BIG_AT.to_string());

    // Quote both tokens: a Windows path may contain spaces. `bun <script> serve`
    // is the command-spec form `CANTE_BIN` promises on every platform.
    let bun = std::env::var("BUN").unwrap_or_else(|_| "bun".to_string());
    let spec = format!("\"{bun}\" \"{}\"", fixture.display());

    let (tx, rx) = mpsc::channel();
    let daemon = Daemon::with_config(
        Arc::new(ChannelEmitter { tx }),
        std::env::temp_dir(),
        Some(spec.clone()),
    );

    let start = Instant::now();
    daemon
        .start_session(StartSessionArgs::default())
        .expect("StartSession should be written to the daemon");

    let deadline = start + SOAK_TIMEOUT;
    let mut expected: u64 = 1;
    let mut seen: u64 = 0;
    let mut big_len: Option<usize> = None;
    let mut big_elapsed: Option<Duration> = None;
    let mut cursor: u64 = 0;
    let mut pages: u64 = 0;

    while seen < FLOOD_EVENTS {
        assert!(
            Instant::now() < deadline,
            "the flood stalled after {seen}/{FLOOD_EVENTS} events (big line framed: {big_len:?})"
        );
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Wire::Event(frame)) => {
                let seq = seq_of(&frame).unwrap_or_else(|| panic!("frame {seen} has no flood id"));
                assert_eq!(
                    seq, expected,
                    "events must arrive exactly once and in order (expected {expected}, got {seq})"
                );
                expected += 1;
                seen += 1;
                if seq == BIG_AT {
                    let text = frame
                        .pointer("/event/MessageDelta")
                        .and_then(Value::as_str)
                        .expect("the big frame is a MessageDelta string");
                    big_len = Some(text.len());
                    big_elapsed = Some(start.elapsed());
                }
                if seen % PAGE_EVERY == 0 {
                    cursor = check_page(&daemon, cursor);
                    pages += 1;
                }
            }
            Ok(Wire::State(_)) | Ok(Wire::Log(_, _)) => {}
            Ok(Wire::Exit(code)) => {
                panic!("the daemon exited early ({code:?}) after {seen} events");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("the emitter channel closed after {seen} events");
            }
        }
    }

    // The big line must have reached the bridge byte-for-byte.
    assert_eq!(
        big_len,
        Some(BIG_BYTES),
        "the oversized MessageDelta must be framed intact (byte length preserved)"
    );
    assert!(pages > 0, "the cursor checks must actually have run");

    // The reader must keep up. Measure the frame that carried the big line:
    // the emitter only sees it after the splitter framed it, so a quadratic
    // rescan shows up as a long delay right here.
    let big_elapsed = big_elapsed.expect("the big event must have arrived");
    let big_mib_per_sec = (BIG_BYTES as f64 / (1024.0 * 1024.0)) / big_elapsed.as_secs_f64();
    assert!(
        big_mib_per_sec >= MIN_BIG_MIB_PER_SEC,
        "framed the {BIG_BYTES}-byte line at only {big_mib_per_sec:.2} MiB/s \
         ({big_elapsed:?}); a quadratic splitter fails this floor"
    );

    // Advance the cursor over the final pages and land exactly on the head.
    while cursor < FLOOD_EVENTS {
        let next = check_page(&daemon, cursor);
        assert!(next > cursor, "paging must make progress");
        cursor = next;
    }
    assert_eq!(cursor, FLOOD_EVENTS, "the cursor lands on the last event");

    // The ring is the memory bound: it retained exactly the tail of the stream,
    // evicting the multi-megabyte event in the process.
    let page = daemon.events_since(0);
    assert_eq!(page["cursor"].as_u64(), Some(FLOOD_EVENTS));
    assert_eq!(page["truncated"].as_bool(), Some(true), "the ring must have wrapped");
    let ring = page["events"].as_array().expect("ring events");
    assert_eq!(ring.len(), RING_CAPACITY, "the ring is bounded at exactly its capacity");
    let first = seq_of(&ring[0]).expect("oldest retained event");
    let last = seq_of(ring.last().unwrap()).expect("newest retained event");
    assert_eq!(last, FLOOD_EVENTS, "the newest event is retained");
    assert_eq!(first + RING_CAPACITY as u64 - 1, last, "only the last capacity events remain");
    assert!(
        first > BIG_AT,
        "the oversized event must have been evicted (first retained {first}, big at {BIG_AT})"
    );

    // The scripted stream ends in `TurnEnd`, so the reduced state lands idle
    // with the session intact and no approval outstanding.
    let state = &page["state"];
    assert_eq!(state["status"], "idle", "the final TurnEnd returns the state to idle");
    assert_eq!(
        state["session"]["session_id"], "ses_FLOODFLOODFLOODFLOODFLOOD0",
        "the SessionStart session survives the flood"
    );
    assert!(state["pending_approval"].is_null(), "no approval is left outstanding");

    // Generous overall throughput floor: the whole stream, not just the line.
    let total_elapsed = start.elapsed();
    let events_per_sec = FLOOD_EVENTS as f64 / total_elapsed.as_secs_f64();
    assert!(
        events_per_sec >= MIN_EVENTS_PER_SEC,
        "only {events_per_sec:.0} events/s over the whole soak ({total_elapsed:?})"
    );

    // Both convergence paths are honoured: `Shutdown` gets a clean exit.
    daemon.shutdown().expect("shutdown");
    let exit_deadline = Instant::now() + Duration::from_secs(15);
    let mut exited = false;
    while Instant::now() < exit_deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Exit(code)) => {
                assert_eq!(code, Some(0), "flood.ts exits cleanly");
                exited = true;
                break;
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(exited, "the daemon should emit cante://exit");

    // The other convergence path: a daemon that is simply dropped closes the
    // child's stdin, and the fixture must exit on that EOF without a Shutdown
    // op. (The emitter stays alive because the reader thread holds its Arc.)
    let (tx2, rx2) = mpsc::channel();
    let daemon2 =
        Daemon::with_config(Arc::new(ChannelEmitter { tx: tx2 }), std::env::temp_dir(), Some(spec));
    daemon2
        .start_session(StartSessionArgs::default())
        .expect("the second StartSession should be written");

    let alive_deadline = Instant::now() + Duration::from_secs(15);
    let mut alive = false;
    while Instant::now() < alive_deadline && !alive {
        match rx2.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Event(_)) => alive = true,
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(alive, "the second fixture run should start emitting");

    drop(daemon2); // closes stdin; the fixture must converge on EOF
    let eof_deadline = Instant::now() + Duration::from_secs(15);
    let mut exited_on_eof = false;
    while Instant::now() < eof_deadline {
        match rx2.recv_timeout(Duration::from_millis(200)) {
            Ok(Wire::Exit(code)) => {
                assert_eq!(code, Some(0), "flood.ts exits cleanly on stdin close");
                exited_on_eof = true;
                break;
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(exited_on_eof, "closing stdin must make the fixture exit");
}
