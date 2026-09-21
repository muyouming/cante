//! Agent Client Protocol (ACP) agent for Cante.
//!
//! `cante-acp` is the process an ACP client (Zed, a JetBrains IDE, ...) launches
//! and talks to over stdio. It drives an installed `cante` binary and
//! translates between the two protocols.

pub mod agent;
pub mod cante_bin;
pub mod permission;
pub mod prompt;
pub mod session;
pub mod tools;
pub mod turn;
