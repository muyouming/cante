//! `initialize` over real stdio against the built binary, driving a stand-in
//! `cante` shell script that only has to answer `--version`.

#![cfg(unix)]

use std::path::PathBuf;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{InitializeRequest, InitializeResponse};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Error};

/// Write `body` as an executable script named `binary` in a directory unique
/// to `name`.
fn fake_in(name: &str, binary: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("cante-acp-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(binary);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The product's own executable name.
fn fake_cante(name: &str, body: &str) -> PathBuf {
    fake_in(name, "cante", body)
}

/// The legacy name the same daemon is still installed under on some machines
/// (AGENTS.md §6 points `CANTE_BIN` at `…/cante-bin/ante`).
fn fake_legacy_ante(name: &str, body: &str) -> PathBuf {
    fake_in(name, "ante", body)
}

async fn initialize_with_env(fake: PathBuf, env_var: &str) -> Result<InitializeResponse, Error> {
    let config = AcpAgentConfig::new(env!("CARGO_BIN_EXE_cante-acp"))
        .env(env_var, fake.display().to_string())
        // An empty value re-enables the check if the developer's shell skips it.
        .env("CANTE_ACP_SKIP_VERSION_CHECK", "");
    Client
        .builder()
        .connect_with(AcpAgent::new(config), |cx: ConnectionTo<Agent>| async move {
            cx.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await
        })
        .await
}

async fn initialize_with(fake: PathBuf) -> Result<InitializeResponse, Error> {
    initialize_with_env(fake, "CANTE").await
}

#[tokio::test]
async fn initialize_reports_the_adapter() {
    let response = initialize_with(fake_cante("current", "echo 'cante 0.2.1'"))
        .await
        .expect("initialize succeeds");

    assert_eq!(response.protocol_version, ProtocolVersion::V1);
    let info = response.agent_info.expect("agent info");
    assert_eq!(info.name, "cante-acp");
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn initialize_refuses_an_old_cante() {
    let error = initialize_with(fake_cante("old", "echo 'cante 0.1.0'"))
        .await
        .expect_err("old cante is refused");

    assert!(error.message.contains("cante 0.1.0"), "{}", error.message);
    assert!(error.message.contains("0.2.1"), "{}", error.message);
}

#[tokio::test]
async fn initialize_refuses_a_failing_cante() {
    let error = initialize_with(fake_cante("failing", "echo 'cante 0.2.1'; exit 3"))
        .await
        .expect_err("a failing cante is refused even if it prints a version");

    assert!(error.message.contains("failed with"), "{}", error.message);
}

/// An older launcher runs `ante acp` and exports the legacy name; the daemon
/// it points at is the same one, installed as `ante`.
#[tokio::test]
async fn initialize_accepts_the_legacy_ante_name_and_env_var() {
    let response = initialize_with_env(fake_legacy_ante("legacy", "echo 'ante 0.2.1'"), "ANTE")
        .await
        .expect("the legacy name still works");

    assert_eq!(response.protocol_version, ProtocolVersion::V1);
}
