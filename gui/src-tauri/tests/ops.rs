//! Op payload shapes — especially the case folding the frozen frontend types
//! need (PascalCase enum constants vs the daemon's lowercase wire enums).
use cante_gui_lib::daemon::{start_session_op, update_session_op, StartSessionArgs};
use serde_json::json;

#[test]
fn start_session_builds_a_session_request() {
    let op = start_session_op(StartSessionArgs {
        model: Some("fake-model".to_string()),
        provider: Some("fake".to_string()),
        effort: Some("High".to_string()),
        permission_mode: Some("Strict".to_string()),
        cwd: Some("/tmp".to_string()),
        resume_session_id: None,
    });
    assert_eq!(
        op,
        json!({ "StartSession": {
            "model": "fake-model",
            "provider": "fake",
            "effort": "high",
            "permission_mode": "strict",
            "cwd": "/tmp",
        }})
    );
}

#[test]
fn start_session_omits_unset_fields() {
    let op = start_session_op(StartSessionArgs::default());
    assert_eq!(op, json!({ "StartSession": {} }));
}

#[test]
fn resume_session_takes_precedence() {
    let op = start_session_op(StartSessionArgs {
        model: Some("ignored".to_string()),
        resume_session_id: Some("ses_1".to_string()),
        ..Default::default()
    });
    assert_eq!(op, json!({ "ResumeSession": { "session_id": "ses_1", "unattended": false } }));
}

#[test]
fn update_session_accepts_a_model_id_or_spec() {
    let by_id = update_session_op(Some(json!("fake-model")), None, None).unwrap();
    assert_eq!(by_id, json!({ "UpdateSession": { "model": { "id": "fake-model" } } }));

    let by_spec =
        update_session_op(Some(json!({ "id": "fake-model", "effort": "Medium" })), None, None)
            .unwrap();
    assert_eq!(
        by_spec,
        json!({ "UpdateSession": { "model": { "id": "fake-model", "effort": "medium" } } })
    );

    let mode = update_session_op(None, Some("Yolo".to_string()), Some("title".to_string())).unwrap();
    assert_eq!(
        mode,
        json!({ "UpdateSession": { "permission_mode": "yolo", "title": "title" } })
    );
}

#[test]
fn update_session_rejects_an_empty_patch() {
    assert!(update_session_op(None, None, None).is_err());
}
