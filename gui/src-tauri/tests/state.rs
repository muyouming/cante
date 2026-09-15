//! The contract's status / pending-approval transition table.
use cante_gui_lib::protocol::{reduce_state, CanteState};
use serde_json::json;

fn apply(state: &mut CanteState, event: serde_json::Value) {
    reduce_state(state, &event);
}

#[test]
fn full_turn_through_approval() {
    let mut state = CanteState::default();
    assert_eq!(state.status, "idle");

    apply(&mut state, json!({ "TurnStart": { "turn_id": "t1" } }));
    assert_eq!(state.status, "thinking");

    apply(&mut state, json!({ "ThinkingDelta": "hmm" }));
    assert_eq!(state.status, "thinking");

    apply(&mut state, json!({ "MessageDelta": "hi" }));
    assert_eq!(state.status, "streaming");

    apply(&mut state, json!({ "AgentMessage": "hi" }));
    assert_eq!(state.status, "streaming");

    apply(
        &mut state,
        json!({
            "TurnPause": {
                "turn_id": "t1",
                "reason": { "Approval": {
                    "tools": [{ "id": "tool_1", "name": "Bash", "args": { "command": "ls" } }],
                    "message": "Allow?"
                }}
            }
        }),
    );
    assert_eq!(state.status, "awaiting");
    let pending = state.pending_approval.clone().expect("pending approval");
    assert_eq!(pending["turn_id"], "t1");
    assert_eq!(pending["message"], "Allow?");
    assert_eq!(pending["tools"][0]["id"], "tool_1");
    assert_eq!(pending["tools"][0]["name"], "Bash");
    assert_eq!(pending["tools"][0]["args"]["command"], "ls");

    // Streaming deltas must not clear the awaiting status.
    apply(&mut state, json!({ "MessageDelta": "still here" }));
    assert_eq!(state.status, "awaiting");
    assert!(state.pending_approval.is_some());

    apply(&mut state, json!({ "TurnResume": { "turn_id": "t1" } }));
    assert_eq!(state.status, "streaming");
    assert!(state.pending_approval.is_none());

    apply(&mut state, json!({ "TurnEnd": { "turn_id": "t1", "status": "Completed", "steps": 2 } }));
    assert_eq!(state.status, "idle");
}

#[test]
fn sessions_replace_and_clear_approvals() {
    let mut state = CanteState::default();
    apply(&mut state, json!({ "TurnStart": { "turn_id": "t1" } }));
    apply(
        &mut state,
        json!({ "TurnPause": { "turn_id": "t1", "reason": { "Approval": { "tools": [], "message": "x" } } } }),
    );
    assert_eq!(state.status, "awaiting");

    apply(&mut state, json!({ "SessionStart": { "session_id": "s1", "cwd": "/tmp" } }));
    assert_eq!(state.status, "idle");
    assert!(state.pending_approval.is_none());
    assert_eq!(state.session.as_ref().unwrap()["session_id"], "s1");

    apply(&mut state, json!({ "SessionUpdated": { "session_id": "s1", "title": "renamed" } }));
    assert_eq!(state.session.as_ref().unwrap()["title"], "renamed");
}

#[test]
fn error_wins_until_a_new_turn() {
    let mut state = CanteState::default();
    apply(&mut state, json!({ "Error": "boom" }));
    assert_eq!(state.status, "error");
    // TurnEnd must not clear an error status.
    apply(&mut state, json!({ "TurnEnd": { "turn_id": "t1", "status": "Completed" } }));
    assert_eq!(state.status, "error");
    apply(&mut state, json!({ "TurnStart": { "turn_id": "t2" } }));
    assert_eq!(state.status, "thinking");
}

#[test]
fn session_end_and_goodbye_go_offline() {
    for name in ["SessionEnd", "Goodbye"] {
        let mut state = CanteState::default();
        apply(&mut state, json!({ "SessionStart": { "session_id": "s1" } }));
        apply(&mut state, json!({ name: {} }));
        assert_eq!(state.status, "offline", "{name} must go offline");
        assert!(state.session.is_none(), "{name} must clear the session");
        assert!(state.pending_approval.is_none());
    }
}

#[test]
fn unknown_events_are_ignored() {
    let mut state = CanteState::default();
    state.status = "streaming".to_string();
    apply(&mut state, json!({ "SomeFutureEvent": { "payload": 1 } }));
    assert_eq!(state.status, "streaming");

    // Unknown payloads and non-objects must not panic or disturb the session.
    apply(&mut state, json!("FutureUnitVariant"));
    apply(&mut state, json!(42));
    apply(&mut state, json!(null));
    assert_eq!(state.status, "streaming");
    assert!(state.pending_approval.is_none());
}

#[test]
fn a_turn_pause_without_an_approval_payload_does_not_open_one() {
    // Every shape below is a `TurnPause` that carries no usable approval: the
    // reason is missing, a different reason, a bare string, an explicit null,
    // or the payload itself is a non-object. None may reach `awaiting`.
    let bare_reasons = [
        json!({ "turn_id": "t1" }),
        json!({ "turn_id": "t1", "reason": null }),
        json!({ "turn_id": "t1", "reason": { "Other": { "message": "nope" } } }),
        json!({ "turn_id": "t1", "reason": "Approval" }),
        json!({ "turn_id": "t1", "reason": { "Approval": null } }),
        json!({ "turn_id": "t1", "reason": { "Approval": "not-an-object" } }),
    ];
    for payload in bare_reasons {
        let mut state = CanteState::default();
        apply(&mut state, json!({ "TurnStart": { "turn_id": "t1" } }));
        apply(&mut state, json!({ "TurnPause": payload.clone() }));
        assert_ne!(state.status, "awaiting", "{payload} must not await");
        assert!(state.pending_approval.is_none(), "{payload} must not open an approval");
    }

    // A non-object TurnPause body must be ignored too.
    let mut state = CanteState::default();
    apply(&mut state, json!({ "TurnPause": "bad" }));
    assert_ne!(state.status, "awaiting");
    assert!(state.pending_approval.is_none());
}

#[test]
fn deltas_during_awaiting_keep_the_approval_open() {
    let mut state = CanteState::default();
    apply(
        &mut state,
        json!({ "TurnPause": {
        "turn_id": "t1",
        "reason": { "Approval": { "message": "Allow?", "tools": [] } }
    } }),
    );
    assert_eq!(state.status, "awaiting");

    for event in [
        json!({ "ThinkingDelta": "thinking" }),
        json!({ "Thinking": { "text": "thinking" } }),
        json!({ "ToolUpdate": { "tool_use_id": "tool_1" } }),
        json!({ "ToolEnd": { "tool_use_id": "tool_1" } }),
    ] {
        apply(&mut state, event.clone());
        assert_eq!(state.status, "awaiting", "{event} must not leave awaiting");
        assert!(state.pending_approval.is_some());
    }

    // TurnEnd clears the prompt even from awaiting.
    apply(&mut state, json!({ "TurnEnd": { "turn_id": "t1", "status": "Completed" } }));
    assert_eq!(state.status, "idle");
    assert!(state.pending_approval.is_none());
}
