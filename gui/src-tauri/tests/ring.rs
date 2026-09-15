//! Event ring: capacity, monotonic cursor, clamping, and truncation.
use cante_gui_lib::daemon::EventRing;
use serde_json::json;

/// Deterministic 64-bit LCG so the churn is random-looking but reproducible.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 =
            self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            0
        } else {
            self.next() % bound
        }
    }
}

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

#[test]
fn seeded_cursor_churn_holds_every_invariant() {
    // Capacities include the degenerate 0 (normalised to 1) and 1.
    for capacity in [0usize, 1, 2, 3, 7, 64, 4096] {
        let effective = capacity.max(1);
        let mut ring = EventRing::new(capacity);
        let mut rng = Lcg(0x00C0_FFEE_0000_0001u64 ^ capacity as u64);
        let mut pushed: u64 = 0;
        let mut previous_cursor: u64 = 0;

        for _ in 0..3000 {
            // Interleave pushes and cursor reads, including cursor values that
            // are stale, current, or past the head.
            if rng.below(10) < 6 {
                for _ in 0..=rng.below(5) {
                    ring.push(json!({ "i": pushed }));
                    pushed += 1;
                }
            }

            let query = match rng.below(4) {
                0 => rng.below(pushed + 8),
                1 => {
                    let span = rng.below(pushed + 1);
                    rng.below(span + 1)
                }
                2 => pushed.saturating_sub(rng.below(pushed + 1)),
                _ => u64::MAX - rng.below(4),
            };

            // Structural invariants.
            assert_eq!(ring.cursor(), pushed, "the cursor counts every push");
            assert!(ring.cursor() >= previous_cursor, "the cursor never goes backwards");
            assert!(ring.len() <= effective, "the ring never exceeds its capacity");
            assert_eq!(
                ring.first_cursor(),
                ring.cursor() - ring.len() as u64,
                "first_cursor is cursor minus len"
            );
            previous_cursor = ring.cursor();

            let (head, truncated, events) = ring.since(query);
            assert_eq!(head, ring.cursor(), "since reports the current head");

            let first = ring.first_cursor();
            assert_eq!(
                truncated,
                query < first,
                "truncated iff the requested cursor fell off the front ({query} < {first}, capacity {capacity})"
            );

            let start = query.max(first).min(head);
            assert_eq!(events.len() as u64, head - start, "since returns exactly [start, head)");
            for (offset, event) in events.iter().enumerate() {
                assert_eq!(
                    event["i"],
                    json!(start + offset as u64),
                    "event contents match their ring index"
                );
            }
        }
    }
}
