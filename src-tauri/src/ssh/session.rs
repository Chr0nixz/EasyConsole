use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::HashAlg;
use russh::keys::PrivateKeyWithHashAlg;
use russh::{client, ChannelMsg};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::copy_bidirectional;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use crate::ssh::host_key::{
    clear_pending_host_key_prompts_for_session, pending_host_key_prompts, EasyConsoleSshClient,
};
use crate::ssh::port_forward::{
    normalize_port_forward_bind_host, socks5_handshake, write_socks5_reply, PortForwardRuleValue,
};
use crate::ssh::sftp::{
    ensure_sftp_session, sftp_delete_path, sftp_download_file, sftp_list_entries, sftp_mkdir_path,
    sftp_rename_path, sftp_upload_file, SftpEntryValue, SftpTaskCtx, SftpTransferOutcome,
    SharedSftpSession,
};
use crate::trf;

#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const SSH_SESSION_EVENT: &str = "ssh-session-event";
pub const HOST_KEY_PROMPT_TIMEOUT_SECS: u64 = 120;

const DEFAULT_COLS: u32 = 120;
const DEFAULT_ROWS: u32 = 32;

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(desktop), allow(dead_code))]
pub struct SshConnectionRequest {
    pub host: String,
    pub port: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub command: Option<String>,
    pub task_id: Option<String>,
    pub task_name: Option<String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    pub connect_timeout_sec: Option<u64>,
    pub keepalive_interval_sec: Option<u64>,
    pub term_type: Option<String>,
    pub ssh_key_path: Option<String>,
    pub auth_mode: Option<String>,
}

impl std::fmt::Debug for SshConnectionRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshConnectionRequest")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("command", &self.command)
            .field("task_id", &self.task_id)
            .field("task_name", &self.task_name)
            .field("cols", &self.cols)
            .field("rows", &self.rows)
            .field("connect_timeout_sec", &self.connect_timeout_sec)
            .field("keepalive_interval_sec", &self.keepalive_interval_sec)
            .field("term_type", &self.term_type)
            .field("ssh_key_path", &self.ssh_key_path)
            .field("auth_mode", &self.auth_mode)
            .finish()
    }
}

pub struct SshSessionContext {
    pub session_id: String,
    pub window_label: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshSessionEvent {
    session_id: String,
    kind: &'static str,
    /// Structured status for `kind: "status"` events: "connecting", "connected",
    /// or "exited". Lets the frontend derive the session state without string
    /// matching on localized messages. `kind: "error"` implies "failed" and
    /// `kind: "closed"` implies "closed"; both carry `None` here.
    phase: Option<&'static str>,
    data: Option<String>,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_sequence: Option<u64>,
}

/// One write chunk queued for the channel writer: safely below the typical
/// SSH maximum packet size.
const SSH_INPUT_CHUNK_BYTES: usize = 16 * 1024;
/// Bounded input queue depth (≈1 MiB in flight). A huge paste back-pressures
/// the `ssh_write` caller instead of growing the queue without limit.
const SSH_INPUT_QUEUE_CHUNKS: usize = 64;

/// xterm acknowledges a batch only after parsing it. Stop reading the SSH
/// channel at this limit; russh's bounded channel then back-pressures TCP.
/// Each packet is at most 32 KiB, plus <8 KiB buffered before the flush (up to
/// 3x after lossy UTF-8 decoding): <2 MiB of unparsed output per session.
const SSH_OUTPUT_MAX_IN_FLIGHT: usize = 16;

#[derive(Default)]
struct SshOutputFlow {
    pending: VecDeque<(u64, usize)>,
    stats: SshOutputStats,
    paused: bool,
}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOutputStats {
    pub emitted_batches: u64,
    pub emitted_bytes: u64,
    pub in_flight_batches: usize,
    pub in_flight_bytes: usize,
    pub peak_in_flight_batches: usize,
    pub backpressure_count: u64,
}

impl SshOutputFlow {
    fn can_emit(&self) -> bool {
        self.pending.len() < SSH_OUTPUT_MAX_IN_FLIGHT
    }

    fn record_batch(&mut self, bytes: usize) -> u64 {
        self.stats.emitted_batches += 1;
        let sequence = self.stats.emitted_batches;
        self.pending.push_back((sequence, bytes));
        self.stats.emitted_bytes += bytes as u64;
        self.stats.in_flight_bytes += bytes;
        self.stats.in_flight_batches = self.pending.len();
        self.stats.peak_in_flight_batches =
            self.stats.peak_in_flight_batches.max(self.pending.len());
        if !self.can_emit() && !self.paused {
            self.stats.backpressure_count += 1;
            self.paused = true;
        }
        sequence
    }

    fn acknowledge(&mut self, sequence: u64) {
        // Ignore stale, duplicate and future ACKs. Only a sequence we actually
        // emitted can release credits, including for cumulative ACKs.
        let Some(index) = self.pending.iter().position(|(sent, _)| *sent == sequence) else {
            return;
        };
        for (_, bytes) in self.pending.drain(..=index) {
            self.stats.in_flight_bytes -= bytes;
        }
        self.stats.in_flight_batches = self.pending.len();
        self.paused = false;
    }

    fn emit<R: Runtime>(&mut self, app: &AppHandle<R>, window: &str, session: &str, text: String) {
        if text.is_empty() {
            return;
        }
        debug_assert!(self.can_emit());
        let sequence = self.record_batch(text.len());
        let _ = app.emit_to(
            window,
            SSH_SESSION_EVENT,
            SshSessionEvent {
                session_id: session.to_string(),
                kind: "output",
                phase: None,
                data: Some(text),
                message: None,
                output_sequence: Some(sequence),
            },
        );
    }
}

pub enum SshCommand {
    OutputAck {
        sequence: u64,
    },
    OutputStats {
        response: oneshot::Sender<SshOutputStats>,
    },
    GpuUtilization {
        response: oneshot::Sender<Result<Vec<f64>, String>>,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
    Close,
    SftpList {
        path: String,
        response: oneshot::Sender<Result<Vec<SftpEntryValue>, String>>,
    },
    SftpUpload {
        local_path: String,
        remote_path: String,
        response: oneshot::Sender<Result<SftpTransferOutcome, String>>,
    },
    SftpDownload {
        remote_path: String,
        local_path: String,
        response: oneshot::Sender<Result<SftpTransferOutcome, String>>,
    },
    SftpDelete {
        path: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SftpRename {
        old_path: String,
        new_path: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SftpMkdir {
        path: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    StartPortForward {
        rule: PortForwardRuleValue,
        response: oneshot::Sender<Result<u16, String>>,
    },
    StopPortForward {
        rule_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    /// Aborts one SFTP upload/download. With a transfer id it cancels exactly
    /// that transfer; without one it cancels the most recently started one.
    CancelSftp {
        transfer_id: Option<String>,
        response: oneshot::Sender<Result<(), String>>,
    },
    /// Sent by a spawned transfer task when it ran to completion on its own
    /// (success, failure, or cooperative cancellation). The session loop owns
    /// the response channel and forwards the outcome to the invoking command.
    TransferFinished {
        transfer_id: String,
        outcome: Result<SftpTransferOutcome, String>,
    },
    /// Sent by a port-forward listener task when `accept()` failed and the
    /// listener died on its own; the loop must retire the rule so the UI does
    /// not keep showing it as active.
    ForwardListenerDied {
        rule_id: String,
        error: String,
    },
}

#[derive(Default)]
pub struct SshSessionState {
    sessions: Mutex<HashMap<String, SshSessionEntry>>,
}

struct SshSessionEntry {
    tx: mpsc::UnboundedSender<SshCommand>,
    cancel_tx: watch::Sender<bool>,
    /// Bounded queue feeding the session's dedicated channel writer. Kept on
    /// the entry so `ssh_write` can back-pressure without touching the command
    /// loop (SSH-P2-07).
    input_tx: mpsc::Sender<Vec<u8>>,
    window_label: String,
    /// Canonicalized directories the user picked through a native dialog this
    /// session. SFTP local paths must resolve inside one of them, so a
    /// compromised renderer cannot read or write arbitrary local files
    /// (SSH-P2-09).
    sftp_local_roots: Mutex<HashSet<PathBuf>>,
}

/// A single in-flight SFTP transfer tracked by the session loop. The loop owns
/// the response channel so cancellation can resolve the invoking command even
/// when the worker task is hard-aborted; `part_path` and the `remote_temp_path`
/// slot drive best-effort temp-file cleanup after an abort (the upload worker
/// fills the slot as soon as its temp file exists).
struct SftpTransferHandle {
    operation: &'static str,
    cancel: Arc<AtomicBool>,
    handle: tokio::task::JoinHandle<()>,
    response: oneshot::Sender<Result<SftpTransferOutcome, String>>,
    part_path: Option<String>,
    remote_temp_path: Arc<AsyncMutex<Option<String>>>,
}

impl SshSessionState {
    /// Runs `f` with the owner-validated session entry. IPC commands are
    /// addressed by `session_id` alone, so without this check any webview
    /// that learns a session id could write to it, read its files, or close it.
    fn with_owned_entry<T, R: Runtime>(
        &self,
        window: &tauri::WebviewWindow<R>,
        session_id: &str,
        f: impl FnOnce(&SshSessionEntry) -> Result<T, String>,
    ) -> Result<T, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| trf!("SSH 会话状态已损坏", "The SSH session state is corrupted"))?;
        let entry = sessions.get(session_id).ok_or_else(|| {
            trf!(
                "SSH 会话不存在或已关闭",
                "The SSH session does not exist or is closed"
            )
        })?;
        if entry.window_label != window.label() {
            return Err(trf!(
                "拒绝跨窗口操作 SSH 会话",
                "Cross-window SSH session access is not allowed"
            ));
        }
        f(entry)
    }

    /// Resolves a session's command channel for a calling window.
    pub fn resolve_owned<R: Runtime>(
        &self,
        window: &tauri::WebviewWindow<R>,
        session_id: &str,
    ) -> Result<mpsc::UnboundedSender<SshCommand>, String> {
        self.with_owned_entry(window, session_id, |entry| Ok(entry.tx.clone()))
    }

    /// Same owner check as [`Self::resolve_owned`], but resolves the bounded
    /// input queue that feeds the session's channel writer.
    pub fn resolve_owned_input<R: Runtime>(
        &self,
        window: &tauri::WebviewWindow<R>,
        session_id: &str,
    ) -> Result<mpsc::Sender<Vec<u8>>, String> {
        self.with_owned_entry(window, session_id, |entry| Ok(entry.input_tx.clone()))
    }

    /// Records a user-picked directory as an allowed root for SFTP local
    /// paths (SSH-P2-09). The root must exist and be a directory; it is
    /// canonicalized so later comparisons see through symlinks.
    pub fn register_sftp_local_root<R: Runtime>(
        &self,
        window: &tauri::WebviewWindow<R>,
        session_id: &str,
        raw_root: &str,
    ) -> Result<(), String> {
        let root = validate_local_path(raw_root)?;
        let root = root.canonicalize().map_err(|error| {
            trf!(
                "本地目录不存在：{error}",
                "The local directory does not exist: {error}"
            )
        })?;
        if !root.is_dir() {
            return Err(trf!(
                "允许的本地路径必须是文件夹",
                "The allowed local path must be a directory"
            ));
        }
        self.with_owned_entry(window, session_id, |entry| {
            entry
                .sftp_local_roots
                .lock()
                .map_err(|_| trf!("SSH 会话状态已损坏", "The SSH session state is corrupted"))?
                .insert(root);
            Ok(())
        })
    }

    /// Owner-checks a renderer-supplied local path for SFTP uploads and
    /// downloads (SSH-P2-09): absolute, `..`-free, resolving (through symlinks
    /// and not-yet-existing tails) inside a root the user picked this session.
    pub fn ensure_sftp_local_path_allowed<R: Runtime>(
        &self,
        window: &tauri::WebviewWindow<R>,
        session_id: &str,
        raw_path: &str,
    ) -> Result<PathBuf, String> {
        let path = validate_local_path(raw_path)?;
        let resolved = canonical_local_path(&path).ok_or_else(|| {
            trf!(
                "本地路径不存在：{raw_path}",
                "The local path does not exist: {raw_path}"
            )
        })?;
        self.with_owned_entry(window, session_id, |entry| {
            let roots = entry
                .sftp_local_roots
                .lock()
                .map_err(|_| trf!("SSH 会话状态已损坏", "The SSH session state is corrupted"))?;
            if roots.iter().any(|root| resolved.starts_with(root)) {
                Ok(resolved)
            } else {
                Err(trf!(
                    "本地路径不在本次会话选择的目录内",
                    "The local path is outside the directories picked in this session"
                ))
            }
        })
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }

    /// Registers a session outside the normal `open_ssh_session` flow so the
    /// owner-validation tests can drive the registry directly.
    #[cfg(any(test, feature = "ssh-test-internals"))]
    pub fn insert_test_entry(
        &self,
        session_id: &str,
        window_label: &str,
        tx: mpsc::UnboundedSender<SshCommand>,
        input_tx: mpsc::Sender<Vec<u8>>,
        cancel_tx: watch::Sender<bool>,
    ) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(
                session_id.to_string(),
                SshSessionEntry {
                    tx,
                    cancel_tx,
                    input_tx,
                    window_label: window_label.to_string(),
                    sftp_local_roots: Mutex::new(HashSet::new()),
                },
            );
        }
    }
}

/// Pending SSH connection requests for popped-out windows, keyed by window
/// label. The main window calls `open_ssh_window`, which stores the request
/// here; the new window retrieves it via `get_ssh_window_request` after its
/// React app mounts. This avoids fragile URL hash encoding and event
/// timing races (Tauri emits before the frontend `listen` registers).
#[cfg(desktop)]
#[derive(Default)]
pub struct PendingSshWindows {
    requests: Mutex<HashMap<String, SshWindowRequest>>,
}

#[cfg(desktop)]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTerminalPreferences {
    pub port_forwards: Vec<PortForwardRuleValue>,
    pub max_history_entries: usize,
    pub terminal: serde_json::Value,
}

#[cfg(desktop)]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshWindowRequest {
    request: SshConnectionRequest,
    preferences: SshTerminalPreferences,
}

#[cfg(desktop)]
impl PendingSshWindows {
    /// Drops a stashed connection request without handing it to a window.
    /// Called when a popped-out window is destroyed before (or after) reading
    /// it; the request contains the plaintext password and must not linger.
    pub fn remove_request(&self, label: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(label);
        }
    }
}

pub fn emit_session_event<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    session_id: &str,
    kind: &'static str,
    phase: Option<&'static str>,
    data: Option<String>,
    message: Option<String>,
) {
    // Scope delivery to the window that owns the session: terminal output and
    // SFTP progress must not be broadcast to every webview. The matching JS
    // listener registers with the same window label as its event target.
    let _ = app.emit_to(
        window_label,
        SSH_SESSION_EVENT,
        SshSessionEvent {
            session_id: session_id.to_string(),
            kind,
            phase,
            data,
            message,
            output_sequence: None,
        },
    );
}

pub fn close_sessions_for_window(state: &SshSessionState, window_label: &str) {
    let sessions: Vec<_> = match state.sessions.lock() {
        Ok(mut sessions) => {
            let owned = sessions
                .iter()
                .filter(|(_, entry)| entry.window_label == window_label)
                .map(|(session_id, entry)| {
                    (
                        session_id.clone(),
                        entry.tx.clone(),
                        entry.cancel_tx.clone(),
                    )
                })
                .collect::<Vec<_>>();
            sessions.retain(|_, entry| entry.window_label != window_label);
            owned
        }
        Err(_) => return,
    };
    for (_, sender, cancel_tx) in sessions {
        cancel_tx.send_replace(true);
        let _ = sender.send(SshCommand::Close);
    }
    if let Ok(mut pending) = pending_host_key_prompts().lock() {
        pending.retain(|_, prompt| prompt.window_label != window_label);
    }
}

async fn wait_for_session_cancel(cancel_rx: &mut watch::Receiver<bool>) {
    loop {
        if *cancel_rx.borrow_and_update() {
            return;
        }
        if cancel_rx.changed().await.is_err() {
            return;
        }
    }
}

enum Cancellable<T> {
    Completed(T),
    Cancelled,
}

async fn run_cancellable<T>(
    cancel_rx: &mut watch::Receiver<bool>,
    future: impl Future<Output = T>,
) -> Cancellable<T> {
    tokio::select! {
        biased;
        _ = wait_for_session_cancel(cancel_rx) => Cancellable::Cancelled,
        result = future => Cancellable::Completed(result),
    }
}

pub fn validate_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err(trf!(
            "SSH 主机地址为空，无法建立连接",
            "SSH host is empty; cannot establish a connection"
        ));
    }
    if host.starts_with('-') {
        return Err(trf!(
            "SSH 主机地址不能以 - 开头",
            "The SSH host cannot start with -"
        ));
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Err(trf!(
            "SSH 主机地址包含不支持的字符",
            "SSH host contains unsupported characters"
        ));
    }
    Ok(host.to_string())
}

pub fn parse_port(port: Option<&str>) -> Result<u16, String> {
    let Some(port) = port.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(22);
    };
    port.parse::<u16>()
        .map_err(|_| trf!("SSH 端口不是有效数字", "SSH port is not a valid number"))
}

pub fn validate_username(username: Option<&str>) -> Result<Option<String>, String> {
    let username = username.map(str::trim).filter(|value| !value.is_empty());
    if let Some(username) = username {
        if username.starts_with('-') {
            return Err(trf!(
                "SSH 用户名不能以 - 开头",
                "The SSH username cannot start with -"
            ));
        }
        if !username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        {
            return Err(trf!(
                "SSH 用户名包含不支持的字符",
                "SSH username contains unsupported characters"
            ));
        }
        return Ok(Some(username.to_string()));
    }
    Ok(None)
}

#[cfg(desktop)]
pub fn require_username(username: Option<&str>) -> Result<String, String> {
    validate_username(username)?.ok_or_else(|| {
        trf!(
            "SSH Username 为空，无法建立连接",
            "SSH Username is empty; cannot establish a connection"
        )
    })
}

/// Expands a leading `~` in a private-key path to the user's home directory.
/// The UI advertises `~`-style defaults (`~/.ssh/id_ed25519`), but the SFTP
/// home shortcut does not apply to local paths and `load_secret_key` would
/// otherwise look for a literal `~` directory.
pub fn expand_key_path(path: &str) -> String {
    let trimmed = path.trim();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    let Some(home) = home else {
        return trimmed.to_string();
    };
    if trimmed == "~" {
        return home.to_string_lossy().to_string();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home.join(rest).to_string_lossy().to_string();
    }
    trimmed.to_string()
}

/// Drains `buf` into a UTF-8 string, leaving behind at most the trailing bytes
/// of a multi-byte sequence that was split across SSH channel chunks. Those
/// bytes must survive until the next chunk arrives: `from_utf8_lossy` on each
/// chunk independently would replace every split character with U+FFFD.
/// Genuinely invalid bytes pass through lossily instead of accumulating.
fn drain_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut start = 0;
    loop {
        match std::str::from_utf8(&buf[start..]) {
            Ok(text) => {
                out.push_str(text);
                buf.clear();
                return out;
            }
            Err(error) => {
                let valid_up_to = start + error.valid_up_to();
                out.push_str(std::str::from_utf8(&buf[start..valid_up_to]).unwrap_or_default());
                let invalid_end = match error.error_len() {
                    // Incomplete multi-byte sequence at the end of the buffer;
                    // keep it so the next chunk can complete the character.
                    None => {
                        buf.drain(..valid_up_to);
                        return out;
                    }
                    Some(len) => valid_up_to + len,
                };
                out.push_str(&String::from_utf8_lossy(&buf[valid_up_to..invalid_end]));
                start = invalid_end;
            }
        }
    }
}

/// Final drain for a closing stream: emits everything still buffered, turning
/// any incomplete trailing sequence into replacement characters.
fn flush_utf8(buf: &mut Vec<u8>) -> String {
    let mut text = drain_utf8(buf);
    if !buf.is_empty() {
        text.push_str(&String::from_utf8_lossy(buf));
        buf.clear();
    }
    text
}

/// Validates a renderer-supplied local path before any filesystem access
/// (SSH-P2-09): non-empty, absolute, and free of `..` components.
fn validate_local_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(trf!("本地路径为空", "The local path is empty"));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(trf!(
            "本地路径必须使用绝对路径",
            "The local path must be absolute"
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(trf!(
            "本地路径不允许包含 ..",
            "The local path must not contain .."
        ));
    }
    Ok(path.to_path_buf())
}

/// Resolves a path for within-root validation, tolerating a missing tail (a
/// download target that does not exist yet): the nearest existing ancestor is
/// canonicalized — resolving symlinks — and the literal remainder re-applied
/// (no symlinks can hide inside a path that does not exist).
fn canonical_local_path(path: &Path) -> Option<PathBuf> {
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => {
                // An existing but unresolvable component (including a dangling
                // symlink) must not be treated as a harmless missing tail.
                let canonical_ancestor = ancestor.canonicalize().ok()?;
                let remainder = path.strip_prefix(ancestor).ok()?;
                return Some(if remainder.as_os_str().is_empty() {
                    canonical_ancestor
                } else {
                    canonical_ancestor.join(remainder)
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    None
}

pub async fn run_russh_session<R: Runtime>(
    app: AppHandle<R>,
    request: SshConnectionRequest,
    tx: mpsc::UnboundedSender<SshCommand>,
    mut rx: mpsc::UnboundedReceiver<SshCommand>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut cancel_rx: watch::Receiver<bool>,
    context: SshSessionContext,
) -> Result<(), String> {
    let SshSessionContext {
        session_id,
        window_label,
    } = context;
    let host = validate_host(&request.host)?;
    let port = parse_port(request.port.as_deref())?;
    let username = validate_username(request.username.as_deref())?.ok_or_else(|| {
        trf!(
            "SSH Username 为空，无法建立连接",
            "SSH Username is empty; cannot establish a connection"
        )
    })?;
    let password = request
        .password
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let auth_mode = request.auth_mode.as_deref().unwrap_or("password");
    let cols = request.cols.unwrap_or(DEFAULT_COLS).max(1);
    let rows = request.rows.unwrap_or(DEFAULT_ROWS).max(1);
    // keepaliveIntervalSec === 0 is the documented "disabled" value: it must
    // become no timer at all. `Some(Duration::ZERO)` would arm a zero-second
    // keepalive that fires and re-arms immediately (a keepalive storm).
    let keepalive_interval = match request.keepalive_interval_sec.unwrap_or(20) {
        0 => None,
        secs => Some(Duration::from_secs(secs)),
    };
    let connect_timeout = Duration::from_secs(request.connect_timeout_sec.unwrap_or(15));
    let term_type = request.term_type.as_deref().unwrap_or("xterm-256color");

    // In password mode, password is required. In key mode, it's optional (used as passphrase).
    if auth_mode == "password" && password.is_none() {
        return Err(trf!(
            "SSH Password 为空，无法自动登录",
            "SSH Password is empty; cannot sign in automatically"
        ));
    }

    emit_session_event(
        &app,
        &window_label,
        &session_id,
        "status",
        Some("connecting"),
        None,
        Some(trf!(
            "正在连接 {host}:{port}",
            "Connecting to {host}:{port}"
        )),
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval,
        // russh treats 0 as "never declare the peer dead": with keepalive_max
        // unset a dropped network path keeps the session "connected" forever.
        keepalive_max: 3,
        maximum_packet_size: 32 * 1024,
        channel_buffer_size: 32,
        window_size: 512 * 1024,
        ..<_>::default()
    });
    let host_key_error = Arc::new(Mutex::new(None));
    let handler = EasyConsoleSshClient {
        app: app.clone(),
        session_id: session_id.clone(),
        host: host.clone(),
        port,
        host_key_error: Arc::clone(&host_key_error),
        allow_host_key_prompt: true,
        window_label: window_label.clone(),
        task_id: request.task_id.clone(),
    };
    let tcp_result = match run_cancellable(
        &mut cancel_rx,
        tokio::time::timeout(
            connect_timeout,
            tokio::net::TcpStream::connect((host.as_str(), port)),
        ),
    )
    .await
    {
        Cancellable::Completed(result) => result,
        Cancellable::Cancelled => {
            clear_pending_host_key_prompts_for_session(&session_id);
            return Ok(());
        }
    };
    let tcp_stream = tcp_result
        .map_err(|_| {
            trf!(
                "SSH 连接超时，请检查网络和主机是否可达",
                "SSH connection timed out. Check the network and whether the host is reachable."
            )
        })?
        .map_err(|error| trf!("SSH 连接失败：{error}", "SSH connection failed: {error}"))?;
    // Host-key confirmation (up to 120s) lives inside russh handshake, so it
    // must not share the TCP connect timeout. The handshake still needs its
    // own budget: a host that accepts TCP but never completes the SSH banner
    // exchange would otherwise hang this session task forever. The budget
    // covers the worst case of a pending host-key confirmation.
    let handshake_budget = connect_timeout
        + Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS)
        + Duration::from_secs(15);
    let handshake_result = match run_cancellable(
        &mut cancel_rx,
        tokio::time::timeout(
            handshake_budget,
            client::connect_stream(config, tcp_stream, handler),
        ),
    )
    .await
    {
        Cancellable::Completed(result) => result,
        Cancellable::Cancelled => {
            clear_pending_host_key_prompts_for_session(&session_id);
            return Ok(());
        }
    };
    let mut session = handshake_result
        .map_err(|_| {
            trf!(
                "SSH 握手超时，请检查主机上的 SSH 服务是否正常",
                "The SSH handshake timed out; check whether the SSH service on the host is healthy"
            )
        })?
        .map_err(|error| {
            if let Ok(guard) = host_key_error.lock() {
                if let Some(message) = guard.as_ref() {
                    return message.clone();
                }
            }
            trf!("SSH 连接失败：{error}", "SSH connection failed: {error}")
        })?;

    // Authentication is a couple of round-trips against a live server, but a
    // server that stalls after the handshake must not park the session task
    // either. Wrap the whole attempt in a timeout, floored at 15s: the connect
    // timeout exists to fail fast on unreachable hosts (the TCP stage above),
    // and a very small configured value must not starve real authentication.
    let auth_budget = Duration::from_secs(connect_timeout.as_secs().max(15));
    let auth_result = match run_cancellable(
        &mut cancel_rx,
        tokio::time::timeout(auth_budget, async {
            let auth_result = if auth_mode == "key" {
                let key_path = request
                    .ssh_key_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| trf!("SSH 密钥路径为空", "The SSH key path is empty"))?;
                let passphrase = password.as_deref();
                let key_pair = russh::keys::load_secret_key(expand_key_path(key_path), passphrase)
                    .map_err(|e| {
                        trf!("SSH 密钥加载失败：{e}", "Failed to load the SSH key: {e}")
                    })?;
                let hash = if key_pair.algorithm().is_rsa() {
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|error| {
                            trf!(
                                "SSH RSA 算法协商失败：{error}",
                                "SSH RSA algorithm negotiation failed: {error}"
                            )
                        })?
                        .unwrap_or(Some(HashAlg::Sha256))
                } else {
                    None
                };
                let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash);
                let algorithm = key_with_hash.algorithm().to_string();
                emit_session_event(
                    &app,
                    &window_label,
                    &session_id,
                    "status",
                    Some("connecting"),
                    None,
                    Some(trf!(
                        "正在使用 {algorithm} 进行 SSH 密钥认证",
                        "Authenticating SSH with {algorithm}"
                    )),
                );
                session
                    .authenticate_publickey(&username, key_with_hash)
                    .await
                    .map_err(|error| {
                        trf!(
                            "SSH 密钥认证失败：{error}",
                            "SSH key authentication failed: {error}"
                        )
                    })?
                    .success()
            } else {
                let pwd = password.as_deref().ok_or_else(|| {
                    trf!(
                        "SSH Password 为空，无法自动登录",
                        "SSH Password is empty; cannot sign in automatically"
                    )
                })?;
                crate::ssh::auth::authenticate_password(&mut session, &username, pwd).await?
            };
            Ok::<bool, String>(auth_result)
        }),
    )
    .await
    {
        Cancellable::Cancelled => return Ok(()),
        Cancellable::Completed(result) => result,
    };
    let auth_success = match auth_result {
        Ok(Ok(success)) => success,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            return Err(trf!("SSH 认证超时", "SSH authentication timed out"));
        }
    };
    if !auth_success {
        return Err(if auth_mode == "key" {
            trf!(
                "SSH 密钥认证失败：密钥被拒绝",
                "SSH key authentication failed: the key was rejected"
            )
        } else {
            trf!(
                "SSH 认证失败：用户名或密码不正确",
                "SSH authentication failed: incorrect username or password"
            )
        });
    }

    // Wrap in Arc after authentication so it can be shared with spawned port
    // forwarding tasks. Authentication methods require &mut self, so the Arc
    // must come after all mutable calls.
    let session = Arc::new(session);

    let channel_result = match run_cancellable(&mut cancel_rx, session.channel_open_session()).await
    {
        Cancellable::Cancelled => return Ok(()),
        Cancellable::Completed(result) => result,
    };
    let channel = channel_result.map_err(|error| {
        trf!(
            "SSH 会话打开失败：{error}",
            "Failed to open the SSH session: {error}"
        )
    })?;
    let pty_result = match run_cancellable(
        &mut cancel_rx,
        channel.request_pty(false, term_type, cols, rows, 0, 0, &[]),
    )
    .await
    {
        Cancellable::Cancelled => return Ok(()),
        Cancellable::Completed(result) => result,
    };
    pty_result.map_err(|error| {
        trf!(
            "SSH PTY 请求失败：{error}",
            "SSH PTY request failed: {error}"
        )
    })?;
    let shell_result = match run_cancellable(&mut cancel_rx, channel.request_shell(true)).await {
        Cancellable::Cancelled => return Ok(()),
        Cancellable::Completed(result) => result,
    };
    shell_result.map_err(|error| {
        trf!(
            "SSH Shell 请求失败：{error}",
            "SSH shell request failed: {error}"
        )
    })?;

    emit_session_event(
        &app,
        &window_label,
        &session_id,
        "status",
        Some("connected"),
        None,
        Some(trf!("SSH 已连接", "SSH connected")),
    );

    // Writes run on a dedicated task behind a bounded queue (SSH-P2-07): a
    // huge paste back-pressures at the `ssh_write` boundary instead of either
    // blocking this command loop — Resize/Close/SFTP control must never queue
    // behind a slow channel write — or growing the queue without limit.
    let (mut channel_reader, channel_writer) = channel.split();
    // The write half is shared between the input writer (data) and this loop
    // (window_change, teardown); all methods take `&self`, so an `Arc` works.
    let channel_writer = Arc::new(channel_writer);
    let input_task = tokio::spawn({
        let writer = Arc::clone(&channel_writer);
        let command_tx = tx.clone();
        let app = app.clone();
        let window_label = window_label.clone();
        let session_id = session_id.clone();
        async move {
            while let Some(chunk) = input_rx.recv().await {
                if let Err(error) = writer.data(&chunk[..]).await {
                    emit_session_event(
                        &app,
                        &window_label,
                        &session_id,
                        "error",
                        Some("failed"),
                        None,
                        Some(trf!("SSH 写入失败：{error}", "SSH write failed: {error}")),
                    );
                    // The write path is dead; retire the session through the
                    // regular Close path so output flush and teardown happen.
                    let _ = command_tx.send(SshCommand::Close);
                    break;
                }
            }
        }
    });

    let mut output_buffer: Vec<u8> = Vec::new();
    let mut output_flow = SshOutputFlow::default();
    let mut flush_interval = tokio::time::interval(Duration::from_millis(16));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // SFTP runs in spawned tasks so long transfers never stall the terminal
    // channel below. `sftp_transfers` tracks every in-flight transfer by id —
    // cancel flag, JoinHandle, and the response channel — so cancellation can
    // abort a stalled task immediately and still resolve the invoking command.
    // `latest_sftp_transfer` keeps the legacy "cancel whatever started last"
    // behavior working.
    let shared_sftp: SharedSftpSession = Arc::new(AsyncMutex::new(None));
    let sftp_transfers: AsyncMutex<HashMap<String, SftpTransferHandle>> =
        AsyncMutex::new(HashMap::new());
    let mut latest_sftp_transfer: Option<String> = None;
    // Per-rule abort handles for the accept-loop task. Aborting the listener
    // drops its subconnection JoinSet, which aborts every tunneled connection
    // spawned onto it (SSH-P2-08).
    let mut port_forward_handles: HashMap<String, tokio::task::AbortHandle> = HashMap::new();

    loop {
        tokio::select! {
            _ = wait_for_session_cancel(&mut cancel_rx) => {
                break;
            }
            command = rx.recv() => {
                match command {
                    Some(SshCommand::OutputAck { sequence }) => {
                        output_flow.acknowledge(sequence);
                    }
                    Some(SshCommand::OutputStats { response }) => {
                        let _ = response.send(output_flow.stats.clone());
                    }
                    Some(SshCommand::GpuUtilization { response }) => {
                        let probe_session = Arc::clone(&session);
                        tokio::spawn(async move {
                            let _ = response.send(crate::ssh::gpu::read_utilization(&probe_session).await);
                        });
                    }
                    Some(SshCommand::Resize { cols, rows }) => {
                        if let Err(error) = channel_writer
                            .window_change(cols.max(1), rows.max(1), 0, 0)
                            .await
                        {
                            emit_session_event(
                                &app,
                                &window_label,
                                &session_id,
                                "error",
                                Some("failed"),
                                None,
                                Some(trf!("SSH 窗口尺寸更新失败：{error}", "Failed to update the SSH window size: {error}")),
                            );
                            break;
                        }
                    }
                    Some(SshCommand::Close) | None => {
                        break;
                    }
                    Some(SshCommand::SftpList { path, response }) => {
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        tokio::spawn(async move {
                            let _ = response
                                .send(sftp_list_entries(&sftp_session, &shared_sftp, path).await);
                        });
                    }
                    Some(SshCommand::SftpUpload { local_path, remote_path, response }) => {
                        let transfer_id = Uuid::new_v4().to_string();
                        let cancel = Arc::new(AtomicBool::new(false));
                        let ctx = SftpTaskCtx {
                            app: app.clone(),
                            window_label: window_label.clone(),
                            session_id: session_id.clone(),
                            transfer_id: transfer_id.clone(),
                        };
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        let finished_tx = tx.clone();
                        let remote_temp_path = Arc::new(AsyncMutex::new(None));
                        let handle = tokio::spawn({
                            let remote_temp_path = Arc::clone(&remote_temp_path);
                            let worker_cancel = Arc::clone(&cancel);
                            async move {
                                let outcome = sftp_upload_file(
                                    &ctx,
                                    &sftp_session,
                                    &shared_sftp,
                                    local_path,
                                    remote_path,
                                    &worker_cancel,
                                    &remote_temp_path,
                                )
                                .await;
                                let _ = finished_tx.send(SshCommand::TransferFinished {
                                    transfer_id: ctx.transfer_id,
                                    outcome,
                                });
                            }
                        });
                        latest_sftp_transfer = Some(transfer_id.clone());
                        sftp_transfers.lock().await.insert(
                            transfer_id,
                            SftpTransferHandle {
                                operation: "upload",
                                cancel,
                                handle,
                                response,
                                part_path: None,
                                remote_temp_path,
                            },
                        );
                    }
                    Some(SshCommand::SftpDownload { remote_path, local_path, response }) => {
                        let transfer_id = Uuid::new_v4().to_string();
                        let cancel = Arc::new(AtomicBool::new(false));
                        let ctx = SftpTaskCtx {
                            app: app.clone(),
                            window_label: window_label.clone(),
                            session_id: session_id.clone(),
                            transfer_id: transfer_id.clone(),
                        };
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        let finished_tx = tx.clone();
                        let part_path = format!("{local_path}.part");
                        let handle = tokio::spawn({
                            let worker_cancel = Arc::clone(&cancel);
                            async move {
                                let outcome = sftp_download_file(
                                    &ctx,
                                    &sftp_session,
                                    &shared_sftp,
                                    remote_path,
                                    local_path,
                                    &worker_cancel,
                                )
                                .await;
                                let _ = finished_tx.send(SshCommand::TransferFinished {
                                    transfer_id: ctx.transfer_id,
                                    outcome,
                                });
                            }
                        });
                        latest_sftp_transfer = Some(transfer_id.clone());
                        sftp_transfers.lock().await.insert(
                            transfer_id.clone(),
                            SftpTransferHandle {
                                operation: "download",
                                cancel,
                                handle,
                                response,
                                part_path: Some(part_path),
                                remote_temp_path: Arc::new(AsyncMutex::new(None)),
                            },
                        );
                    }
                    Some(SshCommand::SftpDelete { path, response }) => {
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        tokio::spawn(async move {
                            let _ = response
                                .send(sftp_delete_path(&sftp_session, &shared_sftp, path).await);
                        });
                    }
                    Some(SshCommand::SftpRename { old_path, new_path, response }) => {
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        tokio::spawn(async move {
                            let _ = response.send(
                                sftp_rename_path(&sftp_session, &shared_sftp, old_path, new_path).await,
                            );
                        });
                    }
                    Some(SshCommand::SftpMkdir { path, response }) => {
                        let sftp_session = Arc::clone(&session);
                        let shared_sftp = Arc::clone(&shared_sftp);
                        tokio::spawn(async move {
                            let _ = response
                                .send(sftp_mkdir_path(&sftp_session, &shared_sftp, path).await);
                        });
                    }
                    Some(SshCommand::CancelSftp { transfer_id, response }) => {
                        let mut transfers = sftp_transfers.lock().await;
                        let target_id = match transfer_id.as_deref() {
                            Some(id) => transfers.contains_key(id).then(|| id.to_string()),
                            None => latest_sftp_transfer
                                .clone()
                                .filter(|id| transfers.contains_key(id)),
                        };
                        if let Some(id) = target_id {
                            if let Some(entry) = transfers.remove(&id) {
                                // Flag first so a task racing to finish still
                                // reports "canceled", then abort so a task
                                // stuck on a stalled network read dies now
                                // instead of at the TCP timeout.
                                entry.cancel.store(true, Ordering::Relaxed);
                                entry.handle.abort();
                                let _ = entry.response.send(Ok(SftpTransferOutcome {
                                    transfer_id: id.clone(),
                                    operation: entry.operation,
                                    status: "canceled",
                                    transferred: 0,
                                    total: 0,
                                }));
                                if latest_sftp_transfer.as_deref() == Some(id.as_str()) {
                                    latest_sftp_transfer = None;
                                }
                                // Best-effort temp cleanup after the abort
                                // lands; the aborted task cannot clean up
                                // after itself.
                                let shared = Arc::clone(&shared_sftp);
                                let sftp_session = Arc::clone(&session);
                                tokio::spawn(async move {
                                    let _ = entry.handle.await;
                                    if let Some(part) = entry.part_path {
                                        let _ = tokio::fs::remove_file(part).await;
                                    }
                                    let remote_temp = entry.remote_temp_path.lock().await.clone();
                                    if let Some(temp) = remote_temp {
                                        if let Ok(sftp) =
                                            ensure_sftp_session(&sftp_session, &shared).await
                                        {
                                            let _ = sftp.remove_file(temp).await;
                                        }
                                    }
                                });
                            }
                        }
                        let _ = response.send(Ok(()));
                    }
                    Some(SshCommand::TransferFinished { transfer_id, outcome }) => {
                        if let Some(entry) = sftp_transfers.lock().await.remove(&transfer_id) {
                            let _ = entry.response.send(outcome);
                        }
                    }
                    Some(SshCommand::ForwardListenerDied { rule_id, error }) => {
                        port_forward_handles.remove(&rule_id);
                        emit_session_event(
                            &app,
                            &window_label,
                            &session_id,
                            "port-forward-status",
                            None,
                            Some(
                                serde_json::json!({
                                    "ruleId": rule_id,
                                    "active": false,
                                    "error": error,
                                })
                                .to_string(),
                            ),
                            None,
                        );
                    }
                    Some(SshCommand::StartPortForward { rule, response }) => {
                        let rule_id = rule.id.clone();
                        if rule.forward_type == "remote" {
                            let _ = response.send(Err(trf!("远程端口转发 (-R) 暂不支持", "Remote port forwarding (-R) is not supported yet")));
                            continue;
                        }
                        if port_forward_handles.contains_key(&rule_id) {
                            let _ = response.send(Err(trf!("端口转发规则已在运行", "The port forwarding rule is already running")));
                            continue;
                        }
                        let bind_host = match normalize_port_forward_bind_host(&rule.local_host) {
                            Ok(host) => host,
                            Err(error) => {
                                let _ = response.send(Err(error));
                                continue;
                            }
                        };
                        // Bind before registering the rule: a failed start must
                        // leave the same rule id available for a retry.
                        let listener = match tokio::net::TcpListener::bind((bind_host.as_str(), rule.local_port)).await {
                            Ok(listener) => listener,
                            Err(error) => {
                                let _ = response.send(Err(trf!(
                                    "无法绑定本地转发端口 {}:{}：{error}",
                                    "Failed to bind the local forwarding port {}:{}: {error}",
                                    bind_host, rule.local_port
                                )));
                                continue;
                            }
                        };
                        let local_port = match listener.local_addr() {
                            Ok(address) => address.port(),
                            Err(error) => {
                                let _ = response.send(Err(trf!(
                                    "无法读取本地转发端口：{error}",
                                    "Failed to read the local forwarding port: {error}"
                                )));
                                continue;
                            }
                        };
                        let session_clone = session.clone();
                        let rule_clone = rule.clone();
                        let die_tx = tx.clone();
                        let handle = tokio::spawn(async move {
                            // Subconnection tasks live on this set: when the
                            // accept loop ends — deliberate stop (abort), an
                            // accept error, or a panic unwind — the set is
                            // dropped and aborts every tunneled connection
                            // with it, so no tunnel outlives its rule.
                            let mut subconnections = tokio::task::JoinSet::new();
                            let is_dynamic = rule_clone.forward_type == "dynamic";
                            let remote_host = rule_clone.remote_host.clone();
                            let remote_port = rule_clone.remote_port;
                            loop {
                                let (mut tcp_stream, peer_addr) = match listener.accept().await {
                                    Ok(conn) => conn,
                                    Err(e) => {
                                        // A listener that dies on its own must
                                        // retire its rule: the handle map still
                                        // holds it, so without this the UI keeps
                                        // showing "active" and a restart is
                                        // rejected as "already running".
                                        let _ = die_tx.send(SshCommand::ForwardListenerDied {
                                            rule_id: rule_clone.id.clone(),
                                            error: format!("{e}"),
                                        });
                                        break;
                                    }
                                };
                                let session = session_clone.clone();
                                let remote_host = remote_host.clone();
                                let conn_rule_id = rule_clone.id.clone();
                                subconnections.spawn(async move {
                                    let (dest_host, dest_port) = if is_dynamic {
                                        match socks5_handshake(&mut tcp_stream).await {
                                            Ok(result) => result,
                                            Err(error) => {
                                                log::warn!(
                                                    "SOCKS5 handshake failed for rule {conn_rule_id}: {error}"
                                                );
                                                return;
                                            }
                                        }
                                    } else {
                                        (remote_host, remote_port)
                                    };
                                    let channel = match session
                                        .channel_open_direct_tcpip(
                                            dest_host.as_str(),
                                            dest_port.into(),
                                            peer_addr.ip().to_string(),
                                            peer_addr.port().into(),
                                        )
                                        .await
                                    {
                                        Ok(channel) => {
                                            if is_dynamic
                                                && write_socks5_reply(&mut tcp_stream, 0)
                                                    .await
                                                    .is_err()
                                            {
                                                return;
                                            }
                                            channel
                                        }
                                        // One failed tunnel must not report the
                                        // whole rule inactive: the listener keeps
                                        // accepting, and the client's own failed
                                        // connection is the per-connection signal.
                                        Err(error) => {
                                            if is_dynamic {
                                                let _ = write_socks5_reply(&mut tcp_stream, 1).await;
                                            }
                                            log::warn!(
                                                "port forward {conn_rule_id} tunnel to {dest_host}:{dest_port} failed: {error}"
                                            );
                                            return;
                                        }
                                    };
                                    let mut channel_stream = channel.into_stream();
                                    let _ = copy_bidirectional(&mut tcp_stream, &mut channel_stream).await;
                                });
                            }
                            drop(subconnections);
                        });
                        port_forward_handles.insert(rule_id.clone(), handle.abort_handle());
                        // The accept loop reports its own accept errors; this
                        // watcher only covers the path it cannot report — a
                        // panic. Deliberate aborts (StopPortForward, session
                        // teardown) are intentional, not failures.
                        tokio::spawn({
                            let die_tx = tx.clone();
                            let dead_rule_id = rule_id.clone();
                            async move {
                                if let Err(error) = handle.await {
                                    if error.is_panic() {
                                        let _ = die_tx.send(SshCommand::ForwardListenerDied {
                                            rule_id: dead_rule_id,
                                            error: trf!(
                                                "转发监听任务异常退出",
                                                "The forwarding listener task exited unexpectedly"
                                            ),
                                        });
                                    }
                                }
                            }
                        });
                        emit_session_event(
                            &app,
                            &window_label,
                            &session_id,
                            "port-forward-status",
                            None,
                            Some(serde_json::json!({
                                "ruleId": rule_id,
                                "active": true,
                                "localPort": local_port,
                            }).to_string()),
                            None,
                        );
                        let _ = response.send(Ok(local_port));
                    }
                    Some(SshCommand::StopPortForward { rule_id, response }) => {
                        if let Some(handle) = port_forward_handles.remove(&rule_id) {
                            handle.abort();
                        }
                        emit_session_event(
                            &app,
                            &window_label,
                            &session_id,
                            "port-forward-status",
                            None,
                            Some(
                                serde_json::json!({
                                    "ruleId": rule_id,
                                    "active": false,
                                })
                                    .to_string(),
                            ),
                            None,
                        );
                        let _ = response.send(Ok(()));
                    }
                }
            }
            message = channel_reader.wait(), if output_flow.can_emit() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        output_buffer.extend_from_slice(&data);
                        if output_buffer.len() >= 8192 {
                            let text = drain_utf8(&mut output_buffer);
                            if !text.is_empty() {
                                output_flow.emit(&app, &window_label, &session_id, text);
                            }
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        let text = flush_utf8(&mut output_buffer);
                        if !text.is_empty() {
                            output_flow.emit(&app, &window_label, &session_id, text);
                        }
                        emit_session_event(
                            &app,
                            &window_label,
                            &session_id,
                            "status",
                            Some("exited"),
                            None,
                            Some(trf!("SSH 进程已退出，状态码 {exit_status}", "The SSH process exited with status {exit_status}")),
                        );
                    }
                    ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                        let text = flush_utf8(&mut output_buffer);
                        if !text.is_empty() {
                            output_flow.emit(&app, &window_label, &session_id, text);
                        }
                        emit_session_event(
                            &app,
                            &window_label,
                            &session_id,
                            "status",
                            Some("exited"),
                            None,
                            Some(trf!("SSH 进程收到信号 {signal_name:?}: {error_message}", "The SSH process received signal {signal_name:?}: {error_message}")),
                        );
                    }
                    ChannelMsg::Eof => {
                        let text = flush_utf8(&mut output_buffer);
                        if !text.is_empty() {
                            output_flow.emit(&app, &window_label, &session_id, text);
                        }
                    }
                    ChannelMsg::Close => {
                        let text = flush_utf8(&mut output_buffer);
                        if !text.is_empty() {
                            output_flow.emit(&app, &window_label, &session_id, text);
                        }
                        break;
                    }
                    _ => {}
                }
            }
            _ = flush_interval.tick(), if output_flow.can_emit() => {
                if !output_buffer.is_empty() {
                    let text = drain_utf8(&mut output_buffer);
                    if !text.is_empty() {
                        output_flow.emit(&app, &window_label, &session_id, text);
                    }
                }
            }
        }
    }

    if output_flow.can_emit() {
        let text = flush_utf8(&mut output_buffer);
        output_flow.emit(&app, &window_label, &session_id, text);
    }
    log::debug!("SSH output flow {session_id}: {:?}", output_flow.stats);
    // The connection is going away: stop the input writer first (a stalled
    // channel write must not keep it alive), then abort any in-flight SFTP
    // transfers and resolve their invoking commands now — a transfer stuck on
    // a dead channel must not leave the caller waiting for the TCP timeout.
    input_task.abort();
    {
        let transfers: Vec<_> = sftp_transfers.lock().await.drain().collect();
        for (_, entry) in transfers {
            entry.cancel.store(true, Ordering::Relaxed);
            entry.handle.abort();
            let _ = entry.response.send(Err(trf!(
                "SSH 会话已关闭，传输已终止",
                "The SSH session closed; the transfer was aborted"
            )));
        }
    }
    for (_, handle) in port_forward_handles.drain() {
        handle.abort();
    }
    let _ = channel_writer.eof().await;
    let _ = channel_writer.close().await;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    Ok(())
}

#[tauri::command]
pub fn open_ssh_session(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<SshSessionState>>,
    request: SshConnectionRequest,
) -> Result<String, String> {
    crate::require_main_or_ssh_window(window.label())?;
    validate_host(&request.host)?;
    parse_port(request.port.as_deref())?;
    validate_username(request.username.as_deref())?;

    let session_id = Uuid::new_v4().to_string();
    let window_label = window.label().to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    let (input_tx, input_rx) = mpsc::channel(SSH_INPUT_QUEUE_CHUNKS);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state
        .sessions
        .lock()
        .map_err(|_| trf!("SSH 会话状态已损坏", "The SSH session state is corrupted"))?
        .insert(
            session_id.clone(),
            SshSessionEntry {
                tx: tx.clone(),
                cancel_tx,
                input_tx,
                window_label: window_label.clone(),
                sftp_local_roots: Mutex::new(HashSet::new()),
            },
        );

    let task_state = Arc::clone(&state);
    let task_session_id = session_id.clone();
    let task_window_label = window_label.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_russh_session(
            app.clone(),
            request,
            tx,
            rx,
            input_rx,
            cancel_rx,
            SshSessionContext {
                session_id: task_session_id.clone(),
                window_label: task_window_label.clone(),
            },
        )
        .await
        {
            emit_session_event(
                &app,
                &task_window_label,
                &task_session_id,
                "error",
                Some("failed"),
                None,
                Some(error),
            );
        }
        task_state.remove(&task_session_id);
        emit_session_event(
            &app,
            &task_window_label,
            &task_session_id,
            "closed",
            Some("closed"),
            None,
            Some(trf!("SSH 会话已关闭", "The SSH session is closed")),
        );
    });

    Ok(session_id)
}

pub fn send_session_command<R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: &tauri::WebviewWindow<R>,
    session_id: &str,
    command: SshCommand,
) -> Result<(), String> {
    let sender = state.resolve_owned(window, session_id)?;
    sender
        .send(command)
        .map_err(|_| trf!("SSH 会话已关闭", "The SSH session is closed"))
}

pub async fn send_session_command_with_response<T, R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: &tauri::WebviewWindow<R>,
    session_id: &str,
    build_command: impl FnOnce(oneshot::Sender<Result<T, String>>) -> SshCommand,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let command = build_command(tx);
    send_session_command(state, window, session_id, command)?;
    rx.await.map_err(|_| {
        trf!(
            "SSH 命令响应通道已关闭",
            "The SSH command response channel is closed"
        )
    })?
}

/// Samples GPU utilization over an already authenticated, owner-checked session.
#[tauri::command]
pub async fn ssh_gpu_utilization(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<Vec<f64>, String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::GpuUtilization { response }
    })
    .await
}

/// Writes terminal input to the session's bounded input queue. Awaited sends
/// give back-pressure to the caller once the queue is full (a huge paste),
/// while the session loop stays free to process control commands.
#[tauri::command]
pub async fn ssh_write(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let input_tx = state.resolve_owned_input(&window, &session_id)?;
    for chunk in data.as_bytes().chunks(SSH_INPUT_CHUNK_BYTES) {
        input_tx
            .send(chunk.to_vec())
            .await
            .map_err(|_| trf!("SSH 会话已关闭", "The SSH session is closed"))?;
    }
    Ok(())
}

/// Acknowledges xterm parsing, scoped to the session's owning window.
#[tauri::command]
pub fn ssh_ack_output<R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow<R>,
    session_id: String,
    sequence: u64,
) -> Result<(), String> {
    send_session_command(
        state,
        &window,
        &session_id,
        SshCommand::OutputAck { sequence },
    )
}

#[tauri::command]
pub fn ssh_resize(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    send_session_command(
        state,
        &window,
        &session_id,
        SshCommand::Resize { cols, rows },
    )
}

#[tauri::command]
pub fn ssh_close<R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow<R>,
    session_id: String,
) -> Result<(), String> {
    let (sender, cancel_tx) = state.with_owned_entry(&window, &session_id, |entry| {
        Ok((entry.tx.clone(), entry.cancel_tx.clone()))
    })?;
    cancel_tx.send_replace(true);
    let result = sender
        .send(SshCommand::Close)
        .map_err(|_| trf!("SSH 会话已关闭", "The SSH session is closed"));
    clear_pending_host_key_prompts_for_session(&session_id);
    state.remove(&session_id);
    result
}

/// Open a standalone SSH terminal window. The connection request is stashed
/// in `PendingSshWindows` keyed by the new window's label; the popped-out
/// window retrieves it via `get_ssh_window_request` after its React app
/// mounts. This avoids fragile URL hash encoding/decoding (especially around
/// `?` inside hash fragments), keeps `password` out of the URL, and sidesteps
/// the event-timing race where Tauri emits before the frontend `listen`
/// has registered.
///
/// Must be `async` on Windows: building a WebView2 window inside a synchronous
/// command deadlocks the UI thread (blank window + frozen app).
#[cfg(desktop)]
#[tauri::command]
pub async fn open_ssh_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<PendingSshWindows>>,
    request: SshConnectionRequest,
    preferences: SshTerminalPreferences,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let label = format!(
        "ssh-{}",
        request
            .task_id
            .as_deref()
            .map(str::to_ascii_lowercase)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    );

    // If a window with this label already exists, close it and wait until the
    // label is free before rebuilding with the new connection request.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
        for _ in 0..40 {
            if app.get_webview_window(&label).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if app.get_webview_window(&label).is_some() {
            return Err(trf!(
                "无法关闭已有的 SSH 窗口，请先手动关闭后再试",
                "Cannot close the existing SSH window. Close it manually and try again."
            ));
        }
    }

    let title = format!(
        "SSH - {}",
        request
            .task_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&request.host)
    );

    // Stash the request so the new window can pull it by label.
    {
        let mut map = state
            .requests
            .lock()
            .map_err(|e| trf!("锁失败：{e}", "Lock failed: {e}"))?;
        map.insert(
            label.clone(),
            SshWindowRequest {
                request,
                preferences,
            },
        );
    }

    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("index.html#/ssh-terminal".into()),
    )
    .title(&title)
    .inner_size(960.0, 640.0)
    .min_inner_size(480.0, 320.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .visible(true)
    .focused(true)
    .build()
    .map_err(|e| {
        // Never leave a stashed request (which contains the password) behind
        // when the window it was stashed for failed to materialize.
        if let Ok(mut map) = state.requests.lock() {
            map.remove(&label);
        }
        trf!(
            "SSH 窗口创建失败：{e}",
            "Failed to create the SSH window: {e}"
        )
    })?;

    Ok(())
}

/// Called by a popped-out SSH window to retrieve its pending connection
/// request. The request is removed from the pending map on first read so
/// it cannot be replayed, and only the window the request was stashed for
/// may read it — the payload carries the plaintext password.
#[cfg(desktop)]
#[tauri::command]
pub fn get_ssh_window_request(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<PendingSshWindows>>,
    label: String,
) -> Result<Option<SshWindowRequest>, String> {
    if !window.label().starts_with("ssh-") || window.label() != label {
        return Err(trf!(
            "拒绝跨窗口读取 SSH 连接请求",
            "Reading another window's SSH connection request is not allowed"
        ));
    }
    let mut map = state
        .requests
        .lock()
        .map_err(|e| trf!("锁失败：{e}", "Lock failed: {e}"))?;
    Ok(map.remove(&label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_flow_only_releases_credits_for_emitted_sequences() {
        let mut flow = SshOutputFlow::default();
        for _ in 0..SSH_OUTPUT_MAX_IN_FLIGHT {
            assert!(flow.can_emit());
            flow.record_batch(100);
        }
        assert!(!flow.can_emit());
        assert_eq!(flow.stats.backpressure_count, 1);
        flow.acknowledge(0);
        flow.acknowledge(99);
        assert!(!flow.can_emit());
        assert_eq!(flow.stats.in_flight_bytes, 1600);
        flow.acknowledge(8);
        assert!(flow.can_emit());
        assert_eq!(flow.stats.in_flight_batches, 8);
        assert_eq!(flow.stats.in_flight_bytes, 800);
        flow.acknowledge(8);
        assert_eq!(flow.stats.in_flight_batches, 8);
        flow.acknowledge(16);
        assert_eq!(flow.stats.in_flight_bytes, 0);
        for _ in 0..SSH_OUTPUT_MAX_IN_FLIGHT {
            flow.record_batch(50);
        }
        assert_eq!(flow.stats.backpressure_count, 2);
        assert_eq!(flow.stats.peak_in_flight_batches, 16);
    }

    #[test]
    fn connection_request_debug_redacts_password_and_key_passphrase() {
        for auth_mode in ["password", "key"] {
            let request: SshConnectionRequest = serde_json::from_value(serde_json::json!({
                "host": "example.com",
                "password": "  debug-secret-value  ",
                "authMode": auth_mode,
            }))
            .unwrap();
            for debug in [format!("{request:?}"), format!("{request:#?}")] {
                assert!(debug.contains("example.com"));
                assert!(debug.contains("[REDACTED]"));
                assert!(!debug.contains("debug-secret-value"));
            }
            assert_eq!(
                request.clone().password.as_deref(),
                Some("  debug-secret-value  ")
            );
            assert_eq!(
                serde_json::to_value(&request).unwrap()["password"],
                "  debug-secret-value  "
            );
        }
    }

    #[test]
    fn validate_host_accepts_hostnames_and_rejects_junk() {
        assert_eq!(validate_host(" 10.0.0.8 ").unwrap(), "10.0.0.8");
        assert_eq!(
            validate_host("host.example.com").unwrap(),
            "host.example.com"
        );
        assert_eq!(validate_host("::1").unwrap(), "::1");
        assert_eq!(validate_host("[2001:db8::1]").unwrap(), "[2001:db8::1]");
        assert!(validate_host("").is_err());
        assert!(validate_host("   ").is_err());
        // Whitespace and shell metacharacters must never reach ssh args.
        assert!(validate_host("host example").is_err());
        assert!(validate_host("host;rm").is_err());
        assert!(validate_host("-v").is_err());
        assert!(validate_host(" --proxy-command").is_err());
        // Trailing whitespace (including newlines) is trimmed away, so it
        // cannot smuggle a second argument into the ssh command line.
        assert_eq!(validate_host("host\n").unwrap(), "host");
    }

    #[test]
    fn parse_port_defaults_and_bounds() {
        assert_eq!(parse_port(None).unwrap(), 22);
        assert_eq!(parse_port(Some("")).unwrap(), 22);
        assert_eq!(parse_port(Some(" 30222 ")).unwrap(), 30222);
        assert_eq!(parse_port(Some("0")).unwrap(), 0);
        assert!(parse_port(Some("abc")).is_err());
        assert!(parse_port(Some("70000")).is_err());
        assert!(parse_port(Some("22; rm")).is_err());
    }

    #[test]
    fn validate_username_filters_invalid_characters() {
        assert_eq!(validate_username(None).unwrap(), None);
        assert_eq!(validate_username(Some("  ")).unwrap(), None);
        assert!(validate_username(Some(" -root")).is_err());
        assert!(validate_username(Some("--")).is_err());
        assert_eq!(
            validate_username(Some(" ubuntu ")).unwrap().as_deref(),
            Some("ubuntu")
        );
        assert_eq!(
            validate_username(Some("ops_01")).unwrap().as_deref(),
            Some("ops_01")
        );
        assert!(validate_username(Some("ro ot")).is_err());
        assert!(validate_username(Some("root@host")).is_err());
    }

    #[test]
    fn expand_key_path_resolves_tilde_against_home() {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .expect("a home directory exists in test environments");
        let home = std::path::PathBuf::from(home);

        assert_eq!(
            expand_key_path("~/.ssh/id_ed25519"),
            home.join(".ssh/id_ed25519").to_string_lossy()
        );
        assert_eq!(expand_key_path("~"), home.to_string_lossy());
        // Absolute and relative paths pass through untouched.
        assert_eq!(expand_key_path("C:/keys/host.pem"), "C:/keys/host.pem");
        assert_eq!(expand_key_path("keys/host.pem"), "keys/host.pem");
    }

    #[test]
    fn drain_utf8_passes_ascii_and_clean_utf8_through() {
        let mut buf = b"hello".to_vec();
        assert_eq!(drain_utf8(&mut buf), "hello");
        assert!(buf.is_empty());

        let mut buf = "中文输出".as_bytes().to_vec();
        assert_eq!(drain_utf8(&mut buf), "中文输出");
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_utf8_reassembles_multi_byte_characters_split_across_chunks() {
        // "中" is E4 B8 AD; split after the first byte.
        let mut buf = vec![0xE4];
        assert_eq!(drain_utf8(&mut buf), "");
        assert_eq!(buf, vec![0xE4]);

        buf.extend_from_slice(&[0xB8]);
        assert_eq!(drain_utf8(&mut buf), "");
        assert_eq!(buf, vec![0xE4, 0xB8]);

        buf.extend_from_slice(&[0xAD, b'a']);
        assert_eq!(drain_utf8(&mut buf), "中a");
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_utf8_emits_invalid_bytes_lossily_instead_of_buffering() {
        // 0xFF is never valid UTF-8; it must not stall output behind it.
        let mut buf = vec![0xFF, b'a', b'b'];
        assert_eq!(drain_utf8(&mut buf), "\u{FFFD}ab");
        assert!(buf.is_empty());

        // Invalid byte followed by a split multi-byte sequence: the invalid
        // byte flushes lossily, the split sequence waits for its tail.
        let mut buf = vec![0x80, 0xE4, 0xB8];
        assert_eq!(drain_utf8(&mut buf), "\u{FFFD}");
        assert_eq!(buf, vec![0xE4, 0xB8]);
        buf.extend_from_slice(&[0xAD]);
        assert_eq!(drain_utf8(&mut buf), "中");
    }

    #[test]
    fn flush_utf8_forces_out_incomplete_trailing_sequences() {
        // A stream that ends mid-character must still deliver its bytes.
        let mut buf = vec![b'o', 0xE4, 0xB8];
        assert_eq!(flush_utf8(&mut buf), "o\u{FFFD}");
        assert!(buf.is_empty());

        let mut buf: Vec<u8> = Vec::new();
        assert_eq!(flush_utf8(&mut buf), "");
    }

    #[test]
    fn validate_local_path_rejects_relative_parent_and_empty() {
        let base = std::env::temp_dir();
        assert!(validate_local_path(base.join("ec-file.bin").to_str().unwrap()).is_ok());
        assert!(validate_local_path("").is_err());
        assert!(validate_local_path("   ").is_err());
        assert!(validate_local_path("relative/file.bin").is_err());
        let parent = base.join("sub").join("..").join("ec-file.bin");
        assert!(validate_local_path(parent.to_str().unwrap()).is_err());
    }

    #[test]
    fn canonical_local_path_resolves_existing_files_and_missing_tails() {
        let root = std::env::temp_dir().join(format!("ec-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("file.bin"), b"data").unwrap();

        let canonical_root = root.canonicalize().unwrap();

        // Existing file resolves to itself.
        let existing = canonical_local_path(&root.join("sub").join("file.bin")).unwrap();
        assert!(existing.starts_with(&canonical_root));

        // A not-yet-existing download target resolves through its parent.
        let missing = canonical_local_path(&root.join("sub").join("new.bin")).unwrap();
        assert!(missing.starts_with(&canonical_root));
        assert_eq!(missing.file_name().unwrap(), "new.bin");

        // A tail under an existing root still resolves (inside the root).
        let unresolved_base = canonical_local_path(&root.join("no-such/missing.bin")).unwrap();
        assert!(unresolved_base.starts_with(&canonical_root));

        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn canonical_local_path_resolves_symlink_escapes() {
        let outside = std::env::temp_dir().join(format!("ec-path-out-{}", uuid::Uuid::new_v4()));
        let root = std::env::temp_dir().join(format!("ec-path-in-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(outside.join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let canonical_root = root.canonicalize().unwrap();
        // The symlink resolves outside the root, so the path is not allowed.
        let resolved = canonical_local_path(&root.join("link").join("secret.txt")).unwrap();
        assert!(!resolved.starts_with(&canonical_root));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn canonical_local_path_rejects_dangling_symlinks_instead_of_treating_them_as_missing() {
        let root = tempfile::tempdir().unwrap();
        let link = root.path().join("dangling");
        std::os::unix::fs::symlink(root.path().join("missing"), &link).unwrap();
        assert!(canonical_local_path(&link).is_none());
        assert!(canonical_local_path(&link.join("file.bin")).is_none());
    }
}
