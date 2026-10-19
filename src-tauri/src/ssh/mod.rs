//! Desktop SSH implementation: russh sessions, SFTP transfers, port
//! forwarding, host-key management, VS Code Remote-SSH setup, connection
//! history and system terminal spawning. Split out of lib.rs; every Tauri
//! command keeps its original name so the frontend invoke surface is
//! unchanged.
pub mod history;
pub mod host_key;
pub mod port_forward;
pub mod session;
pub mod sftp;
#[cfg(desktop)]
pub mod terminal_spawn;
#[cfg(any(test, feature = "ssh-test-internals"))]
pub mod test_server;
#[cfg(desktop)]
pub mod vscode;
