//! Event ring: capacity, monotonic cursor, clamping, and truncation.
use cante_gui_lib::daemon::EventRing;
use serde_json::json;

fn ring(capacity: usize, count: u64) -> EventRing {
    let mut ring = EventRing::new(capacity);
    for i in 0..count {
        ring.push(json!({ "i": i }));
    }
    ring
}

#[test]
fn keeps_only_the_last_capacity_events() {
    let ring = ring(4, 10);
    assert_eq!(ring.len(), 4);
    assert_eq!(ring.cursor(), 10);
    assert_eq!(ring.first_cursor(), 6);

    let (cursor, truncated, events) = ring.since(0);
    assert_eq!(cursor, 10);
    assert!(truncated, "a cursor before the ring start is truncated");
    assert_eq!(events.len(), 4);
    assert_eq!(events[0], json!({ "i": 6 }));
    assert_eq!(events[3], json!({ "i": 9 }));
}

#[test]
fn serves_a_cursor_inside_the_ring() {
    let ring = ring(4096, 100);
    let (cursor, truncated, events) = ring.since(98);
    assert_eq!(cursor, 100);
    assert!(!truncated);
    assert_eq!(events, vec![json!({ "i": 98 }), json!({ "i": 99 })]);
}

#[test]
fn clamps_a_cursor_past_the_head() {
    let ring = ring(4, 10);
    let (cursor, truncated, events) = ring.since(999);
    assert_eq!(cursor, 10);
    assert!(!truncated);
    assert!(events.is_empty());
}

#[test]
fn an_empty_ring_serves_nothing_untruncated() {
    let ring = ring(4, 0);
    let (cursor, truncated, events) = ring.since(0);
    assert_eq!(cursor, 0);
    assert!(!truncated);
    assert!(events.is_empty());
}

#[test]
fn full_ring_boundary_is_not_truncated() {
    let ring = ring(4096, 4096);
    let (_, truncated, events) = ring.since(0);
    assert!(!truncated);
    assert_eq!(events.len(), 4096);
    assert_eq!(events[0], json!({ "i": 0 }));
}
