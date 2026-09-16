//! Op payload shapes — especially the case folding the frozen frontend types
//! need (PascalCase enum constants vs the daemon's lowercase wire enums).
use cante_gui_lib::daemon::{
    ambient_phrase_op, ambient_suggestion_op, shell_input_op, start_session_op, steer_op,
    update_session_op, StartSessionArgs,
};
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

#[test]
fn steer_trims_and_rejects_empty() {
    assert_eq!(steer_op("  keep going  ").unwrap(), json!({ "Steer": "keep going" }));
    assert!(steer_op("").is_err());
    assert!(steer_op("   \n").is_err());
}

#[test]
fn shell_input_rejects_empty() {
    assert_eq!(shell_input_op("ls -la").unwrap(), json!({ "ShellInput": "ls -la" }));
    assert!(shell_input_op("").is_err());
    assert!(shell_input_op("  ").is_err());
}

#[test]
fn ambient_phrase_passes_req_id_as_a_number() {
    let op = ambient_phrase_op("a draft", 7);
    assert_eq!(op, json!({ "AmbientPhrase": { "draft": "a draft", "req_id": 7 } }));
    assert!(op["AmbientPhrase"]["req_id"].is_number());
}

#[test]
fn ambient_suggestion_passes_req_id_as_a_number() {
    let op = ambient_suggestion_op("user said", "agent said", 42);
    assert_eq!(
        op,
        json!({ "AmbientSuggestion": {
            "recent_user": "user said",
            "recent_agent": "agent said",
            "req_id": 42,
        }})
    );
    assert!(op["AmbientSuggestion"]["req_id"].is_number());
}
