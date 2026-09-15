//! Locally minted `op_<ULID>` ids.
use cante_gui_lib::protocol::{op_id, ulid, ulid_from};

const CROCKFORD: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[test]
fn has_ulid_shape() {
    let id = ulid();
    assert_eq!(id.len(), 26, "ULID must be 26 chars: {id}");
    assert!(
        id.chars().all(|c| CROCKFORD.contains(c)),
        "ULID uses Crockford base32: {id}"
    );
}

#[test]
fn op_id_is_prefixed() {
    let id = op_id();
    assert!(id.starts_with("op_"), "op id must carry the op_ prefix: {id}");
    assert_eq!(id.len(), 3 + 26);
}

#[test]
fn sorts_by_timestamp() {
    let entropy = [0u8; 16];
    let early = ulid_from(1_700_000_000_000, &entropy);
    let late = ulid_from(1_700_000_100_000, &entropy);
    assert!(early < late, "{early} should sort before {late}");

    // A later prefix beats any entropy suffix on an earlier timestamp.
    let max_entropy = [0xFFu8; 16];
    let min_entropy = [0u8; 16];
    let early_max = ulid_from(1_000, &max_entropy);
    let late_min = ulid_from(2_000, &min_entropy);
    assert!(early_max < late_min, "{early_max} should sort before {late_min}");
}

#[test]
fn distinct_calls_are_distinct() {
    let a = op_id();
    let b = op_id();
    assert_ne!(a, b);
}
