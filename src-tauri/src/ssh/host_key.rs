use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client;
use tokio::sync::oneshot;

use russh::keys::ssh_key::{self, HashAlg};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

use crate::ssh::session::{emit_session_event, HOST_KEY_PROMPT_TIMEOUT_SECS};
use crate::trf;
use crate::{app_data_file, load_string_map, write_string_map};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host_port: String,
    pub algorithm: Option<String>,
    pub public_key: Option<String>,
    pub fingerprint: String,
    pub first_trusted_at: i64,
    pub task_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRecord {
    pub algorithm: Option<String>,
    pub public_key: Option<String>,
    pub fingerprint: String,
    pub first_trusted_at: i64,
    pub task_id: Option<String>,
}

/// Generic over the Tauri runtime so tests can drive it against the mock
/// runtime; production code uses the default (`Wry`).
pub struct EasyConsoleSshClient<R: Runtime = tauri::Wry> {
    pub app: AppHandle<R>,
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub host_key_error: Arc<Mutex<Option<String>>>,
    /// When false, unknown hosts are rejected without prompting (e.g. VS Code setup).
    pub allow_host_key_prompt: bool,
    pub window_label: String,
    pub task_id: Option<String>,
}

// Manual impl: the derived one would require `R: Clone`.
impl<R: Runtime> Clone for EasyConsoleSshClient<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            session_id: self.session_id.clone(),
            host: self.host.clone(),
            port: self.port,
            host_key_error: Arc::clone(&self.host_key_error),
            allow_host_key_prompt: self.allow_host_key_prompt,
            window_label: self.window_label.clone(),
            task_id: self.task_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyDecision {
    Match,
    Unknown { fingerprint: String },
    Mismatch { fingerprint: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPromptPayload {
    prompt_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    previous_fingerprint: Option<String>,
    previous_task_id: Option<String>,
    task_id: Option<String>,
    changed_key: bool,
    task_changed: bool,
    requires_changed_confirmation: bool,
}

pub struct PendingHostKeyPrompt {
    tx: oneshot::Sender<HostKeyConfirmation>,
    pub window_label: String,
    session_id: String,
    requires_changed_confirmation: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct HostKeyConfirmation {
    pub accept: bool,
    pub confirm_changed_key: bool,
}

struct PendingHostKeyGuard {
    prompt_id: String,
}

impl Drop for PendingHostKeyGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = pending_host_key_prompts().lock() {
            pending.remove(&self.prompt_id);
        }
    }
}

pub fn pending_host_key_prompts() -> &'static Mutex<HashMap<String, PendingHostKeyPrompt>> {
    static CELL: OnceLock<Mutex<HashMap<String, PendingHostKeyPrompt>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn clear_pending_host_key_prompts_for_session(session_id: &str) {
    if let Ok(mut pending) = pending_host_key_prompts().lock() {
        pending.retain(|_, prompt| prompt.session_id != session_id);
    }
}

impl<R: Runtime> client::Handler for EasyConsoleSshClient<R> {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let (algorithm, public_key) = match public_key_parts(server_public_key) {
            Ok(parts) => parts,
            Err(message) => {
                self.set_host_key_error(message);
                return Ok(false);
            }
        };
        let key = known_host_key(&self.host, self.port);
        let task_id = normalize_task_id(self.task_id.as_deref());
        let previous = match load_known_hosts(&self.app) {
            Ok(records) => records.get(&key).cloned(),
            Err(message) => {
                self.set_host_key_error(trf!(
                    "无法读取已知 SSH 主机：{message}",
                    "Failed to read known SSH hosts: {message}"
                ));
                return Ok(false);
            }
        };
        let matches = previous
            .as_ref()
            .is_some_and(|record| record.fingerprint == fingerprint);
        let record = KnownHostRecord {
            algorithm: Some(algorithm),
            public_key: Some(public_key),
            fingerprint: fingerprint.clone(),
            first_trusted_at: previous
                .as_ref()
                .filter(|record| record.fingerprint == fingerprint && record.first_trusted_at > 0)
                .map(|record| record.first_trusted_at)
                .unwrap_or_else(now_millis),
            task_id: task_id.or_else(|| {
                previous
                    .as_ref()
                    .filter(|known| known.fingerprint == fingerprint)
                    .and_then(|known| known.task_id.clone())
            }),
        };
        if matches {
            if previous.as_ref() != Some(&record) {
                if let Err(message) = persist_confirmed_host(
                    &self.app,
                    &self.host,
                    self.port,
                    record,
                    Some(&fingerprint),
                ) {
                    self.set_host_key_error(trf!(
                        "无法升级已知 SSH 主机记录：{message}",
                        "Failed to upgrade the known SSH host record: {message}"
                    ));
                    return Ok(false);
                }
            }
            return Ok(true);
        }

        let changed_key = previous.is_some();
        if !self.allow_host_key_prompt {
            self.set_host_key_error(if changed_key {
                trf!(
                    "SSH 主机密钥与已知记录不符（{}:{}），已拒绝连接。",
                    "The SSH host key does not match the known record ({}:{}); connection rejected.",
                    self.host,
                    self.port
                )
            } else {
                trf!(
                    "尚未信任 SSH 主机 {}:{}。请先通过应用内 SSH 确认指纹后再重试。",
                    "The SSH host {}:{} is not trusted yet. Confirm its fingerprint through in-app SSH first, then retry.",
                    self.host,
                    self.port
                )
            });
            return Ok(false);
        }

        self.prompt_for_host_key(record, previous).await
    }
}

impl<R: Runtime> EasyConsoleSshClient<R> {
    fn set_host_key_error(&self, message: String) {
        if let Ok(mut guard) = self.host_key_error.lock() {
            *guard = Some(message);
        }
    }

    async fn prompt_for_host_key(
        &self,
        record: KnownHostRecord,
        previous: Option<KnownHostRecord>,
    ) -> Result<bool, russh::Error> {
        let changed_key = previous.is_some();
        let current_task_id = normalize_task_id(record.task_id.as_deref());
        let task_changed = previous
            .as_ref()
            .and_then(|known| known.task_id.as_ref())
            .zip(current_task_id.as_ref())
            .is_some_and(|(old, new)| old != new);
        let requires_changed_confirmation = changed_key && !task_changed;
        let prompt_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let _guard = PendingHostKeyGuard {
            prompt_id: prompt_id.clone(),
        };
        if let Ok(mut pending) = pending_host_key_prompts().lock() {
            pending.insert(
                prompt_id.clone(),
                PendingHostKeyPrompt {
                    tx,
                    window_label: self.window_label.clone(),
                    session_id: self.session_id.clone(),
                    requires_changed_confirmation,
                },
            );
        } else {
            self.set_host_key_error(trf!(
                "无法等待主机密钥确认：内部状态已损坏",
                "Cannot await host key confirmation: internal state is corrupted"
            ));
            return Ok(false);
        }

        let payload = HostKeyPromptPayload {
            prompt_id,
            host: self.host.clone(),
            port: self.port,
            fingerprint: record.fingerprint.clone(),
            previous_fingerprint: previous.as_ref().map(|known| known.fingerprint.clone()),
            previous_task_id: previous.as_ref().and_then(|known| known.task_id.clone()),
            task_id: record.task_id.clone(),
            changed_key,
            task_changed,
            requires_changed_confirmation,
        };
        emit_session_event(
            &self.app,
            &self.window_label,
            &self.session_id,
            "host-key-prompt",
            None,
            serde_json::to_string(&payload).ok(),
            Some(if changed_key {
                if task_changed {
                    trf!(
                        "主机密钥发生变化，地址对应的任务 ID 已变化。请确认这是平台回收后分配的新实例。",
                        "The host key changed and the task ID differs. Confirm this is a newly assigned instance after host recycling."
                    )
                } else {
                    trf!(
                        "主机密钥发生变化。请核实新旧指纹；除非已确认变更，否则拒绝连接。",
                        "The host key changed. Verify both fingerprints; reject unless you have confirmed the change."
                    )
                }
            } else {
                trf!(
                    "首次连接 {}:{}，请确认主机指纹后继续。",
                    "First connection to {}:{}. Confirm the host fingerprint to continue.",
                    self.host,
                    self.port
                )
            }),
        );

        let confirmation =
            match tokio::time::timeout(Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS), rx).await
            {
                Ok(Ok(value)) => value,
                Ok(Err(_)) | Err(_) => HostKeyConfirmation {
                    accept: false,
                    confirm_changed_key: false,
                },
            };
        if !confirmation.accept
            || (requires_changed_confirmation && !confirmation.confirm_changed_key)
        {
            self.set_host_key_error(trf!(
                "已拒绝或超时未确认 SSH 主机密钥（{}:{}）。",
                "The SSH host key was rejected or not confirmed in time ({}:{}).",
                self.host,
                self.port
            ));
            return Ok(false);
        }

        if let Err(message) = persist_confirmed_host(
            &self.app,
            &self.host,
            self.port,
            record,
            previous.as_ref().map(|known| known.fingerprint.as_str()),
        ) {
            self.set_host_key_error(trf!(
                "无法保存 SSH 主机密钥：{message}",
                "Failed to save the SSH host key: {message}"
            ));
            return Ok(false);
        }
        Ok(true)
    }
}

pub fn known_host_key(host: &str, port: u16) -> String {
    // Bracket bare IPv6 literals so the key stays unambiguous (`::1:22` would
    // not parse back into host + port). An already-bracketed host keeps its
    // form, so both spellings collapse onto the same key.
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn normalize_task_id(task_id: Option<&str>) -> Option<String> {
    task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn evaluate_host_key(
    known_hosts: &HashMap<String, String>,
    key: &str,
    fingerprint: &str,
) -> HostKeyDecision {
    match known_hosts.get(key) {
        Some(known_fingerprint) if known_fingerprint == fingerprint => HostKeyDecision::Match,
        Some(_) => HostKeyDecision::Mismatch {
            fingerprint: fingerprint.to_string(),
        },
        None => HostKeyDecision::Unknown {
            fingerprint: fingerprint.to_string(),
        },
    }
}

pub fn evaluate_known_host<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    port: u16,
    server_public_key: &ssh_key::PublicKey,
) -> Result<HostKeyDecision, String> {
    let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
    let known_hosts = load_known_hosts(app)?;
    let key = known_host_key(host, port);
    Ok(match known_hosts.get(&key) {
        Some(record) if record.fingerprint == fingerprint => HostKeyDecision::Match,
        Some(_) => HostKeyDecision::Mismatch { fingerprint },
        None => HostKeyDecision::Unknown { fingerprint },
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn decode_known_host(value: &str) -> KnownHostRecord {
    serde_json::from_str(value).unwrap_or_else(|_| KnownHostRecord {
        algorithm: None,
        public_key: None,
        fingerprint: value.to_string(),
        first_trusted_at: 0,
        task_id: None,
    })
}

pub fn load_known_hosts<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<HashMap<String, KnownHostRecord>, String> {
    let path = app_data_file(app, "known-ssh-hosts.json")?;
    Ok(load_string_map(&path)?
        .into_iter()
        .map(|(key, value)| (key, decode_known_host(&value)))
        .collect())
}

pub fn public_key_parts(public_key: &ssh_key::PublicKey) -> Result<(String, String), String> {
    let openssh = public_key.to_openssh().map_err(|error| {
        trf!(
            "无法编码 SSH 主机公钥：{error}",
            "Failed to encode the SSH host public key: {error}"
        )
    })?;
    let mut fields = openssh.split_ascii_whitespace();
    let algorithm = fields.next().unwrap_or_default();
    let blob = fields.next().unwrap_or_default();
    if algorithm.is_empty() || blob.is_empty() {
        return Err(trf!(
            "SSH 主机公钥格式无效",
            "The SSH host public key is malformed"
        ));
    }
    Ok((algorithm.to_string(), format!("{algorithm} {blob}")))
}

/// Serializes read-modify-write on `known-ssh-hosts.json`.
///
/// Two sessions connecting to different unknown hosts at the same time would
/// otherwise both load the same snapshot, and the second write would drop the
/// first host key -- silently discarding security-relevant state.
static KNOWN_HOSTS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn known_hosts_lock() -> &'static Mutex<()> {
    KNOWN_HOSTS_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn persist_known_host<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), String> {
    let _guard = known_hosts_lock().lock().map_err(|e| {
        trf!(
            "已知主机锁获取失败：{e}",
            "Failed to acquire the known-hosts lock: {e}"
        )
    })?;
    let path = app_data_file(app, "known-ssh-hosts.json")?;
    let mut known_hosts = load_known_host_values(&path)?;
    known_hosts.insert(
        known_host_key(host, port),
        serde_json::to_string(&KnownHostRecord {
            algorithm: None,
            public_key: None,
            fingerprint: fingerprint.to_string(),
            first_trusted_at: now_millis(),
            task_id: None,
        })
        .map_err(|error| error.to_string())?,
    );
    write_string_map(&path, &known_hosts)?;
    refresh_managed_known_hosts(app, &known_hosts)
}

fn load_known_host_values(path: &Path) -> Result<HashMap<String, String>, String> {
    load_string_map(path)
}

fn refresh_managed_known_hosts<R: Runtime>(
    app: &AppHandle<R>,
    values: &HashMap<String, String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let records = values
            .iter()
            .map(|(key, value)| (key.clone(), decode_known_host(value)))
            .collect::<HashMap<_, _>>();
        crate::ssh::vscode::write_managed_known_hosts(app, &records)?;
    }
    #[cfg(not(desktop))]
    let _ = (app, values);
    Ok(())
}

pub fn persist_confirmed_host<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    port: u16,
    record: KnownHostRecord,
    expected_fingerprint: Option<&str>,
) -> Result<(), String> {
    let _guard = known_hosts_lock().lock().map_err(|error| {
        trf!(
            "已知主机锁获取失败：{error}",
            "Failed to acquire the known-hosts lock: {error}"
        )
    })?;
    let path = app_data_file(app, "known-ssh-hosts.json")?;
    let mut values = load_known_host_values(&path)?;
    let key = known_host_key(host, port);
    let current = values.get(&key).map(|value| decode_known_host(value));
    match (expected_fingerprint, current.as_ref()) {
        (Some(expected), Some(current)) if current.fingerprint == expected => {}
        (None, None) => {}
        (None, Some(current)) if current.fingerprint == record.fingerprint => {}
        _ => {
            return Err(trf!(
                "等待确认期间主机信任记录已变化，请重新连接并核对指纹",
                "The host trust record changed while confirmation was pending; reconnect and verify the fingerprint again"
            ));
        }
    }
    values.insert(
        key,
        serde_json::to_string(&record).map_err(|error| error.to_string())?,
    );
    write_string_map(&path, &values)?;
    refresh_managed_known_hosts(app, &values)
}

pub fn ssh_known_hosts_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app_data_file(app, "known-ssh-hosts.openssh")
}

#[tauri::command]
pub fn list_known_hosts(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<KnownHostEntry>, String> {
    crate::require_main_window(window.label())?;
    let known_hosts = load_known_hosts(&app)?;
    Ok(known_hosts
        .iter()
        .map(|(host_port, record)| KnownHostEntry {
            host_port: host_port.clone(),
            algorithm: record.algorithm.clone(),
            public_key: record.public_key.clone(),
            fingerprint: record.fingerprint.clone(),
            first_trusted_at: record.first_trusted_at,
            task_id: record.task_id.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn confirm_known_host<R: Runtime>(
    window: tauri::WebviewWindow<R>,
    prompt_id: String,
    accept: bool,
    confirm_changed_key: bool,
) -> Result<(), String> {
    crate::require_main_or_ssh_window(window.label())?;
    let mut prompts = pending_host_key_prompts().lock().map_err(|_| {
        trf!(
            "无法确认主机密钥：内部状态已损坏",
            "Cannot confirm the host key: internal state is corrupted"
        )
    })?;
    let pending = prompts.get(&prompt_id).ok_or_else(|| {
        trf!(
            "主机密钥确认请求已失效或超时",
            "The host key confirmation request expired or timed out"
        )
    })?;
    if pending.window_label != window.label() {
        return Err(trf!(
            "拒绝跨窗口确认 SSH 主机密钥",
            "Confirming another window's SSH host key is not allowed"
        ));
    }
    let pending = prompts.remove(&prompt_id).expect("owner-validated prompt");
    drop(prompts);
    let accepted = accept && (!pending.requires_changed_confirmation || confirm_changed_key);
    pending
        .tx
        .send(HostKeyConfirmation {
            accept: accepted,
            confirm_changed_key,
        })
        .map_err(|_| {
            trf!(
                "主机密钥确认通道已关闭",
                "The host key confirmation channel is closed"
            )
        })
}

#[tauri::command]
pub fn remove_known_host(
    app: AppHandle,
    window: tauri::WebviewWindow,
    host_port: String,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let _guard = known_hosts_lock().lock().map_err(|e| {
        trf!(
            "已知主机锁获取失败：{e}",
            "Failed to acquire the known-hosts lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    let mut known_hosts = load_string_map(&path)?;
    known_hosts.remove(&host_port);
    write_string_map(&path, &known_hosts)?;
    refresh_managed_known_hosts(&app, &known_hosts)
}

#[tauri::command]
pub fn clear_known_hosts(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let _guard = known_hosts_lock().lock().map_err(|e| {
        trf!(
            "已知主机锁获取失败：{e}",
            "Failed to acquire the known-hosts lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    let empty = HashMap::new();
    write_string_map(&path, &empty)?;
    refresh_managed_known_hosts(&app, &empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_host_key_uses_host_port() {
        assert_eq!(known_host_key("example.com", 22), "example.com:22");
        assert_eq!(known_host_key("127.0.0.1", 2222), "127.0.0.1:2222");
    }

    #[test]
    fn known_host_key_brackets_bare_ipv6_literals() {
        assert_eq!(known_host_key("::1", 22), "[::1]:22");
        assert_eq!(known_host_key("2001:db8::1", 2200), "[2001:db8::1]:2200");
        // An already-bracketed host keeps its form so both spellings of the
        // same literal land on the same key.
        assert_eq!(known_host_key("[::1]", 22), "[::1]:22");
        // Bare IPv4-style hosts are never bracketed.
        assert_eq!(known_host_key("10.0.0.1", 22), "10.0.0.1:22");
    }

    #[test]
    fn evaluate_host_key_distinguishes_unknown_match_and_mismatch() {
        let mut known_hosts = HashMap::new();
        let key = known_host_key("example.com", 22);

        assert_eq!(
            evaluate_host_key(&known_hosts, &key, "SHA256:first"),
            HostKeyDecision::Unknown {
                fingerprint: "SHA256:first".to_string()
            }
        );

        known_hosts.insert(key.clone(), "SHA256:first".to_string());
        assert_eq!(
            evaluate_host_key(&known_hosts, &key, "SHA256:first"),
            HostKeyDecision::Match
        );
        assert_eq!(
            evaluate_host_key(&known_hosts, &key, "SHA256:changed"),
            HostKeyDecision::Mismatch {
                fingerprint: "SHA256:changed".to_string()
            }
        );
    }

    #[test]
    fn evaluate_host_key_treats_empty_map_as_unknown() {
        let known_hosts = HashMap::new();
        assert_eq!(
            evaluate_host_key(&known_hosts, "host:22", "SHA256:abc"),
            HostKeyDecision::Unknown {
                fingerprint: "SHA256:abc".to_string()
            }
        );
    }

    #[test]
    fn decodes_legacy_fingerprint_values_and_structured_records() {
        let legacy = decode_known_host("SHA256:legacy");
        assert_eq!(legacy.fingerprint, "SHA256:legacy");
        assert!(legacy.public_key.is_none());
        assert!(legacy.algorithm.is_none());

        let structured = decode_known_host(
            r#"{"algorithm":"ssh-ed25519","publicKey":"ssh-ed25519 blob","fingerprint":"SHA256:new","firstTrustedAt":123,"taskId":"task-1"}"#,
        );
        assert_eq!(structured.algorithm.as_deref(), Some("ssh-ed25519"));
        assert_eq!(structured.public_key.as_deref(), Some("ssh-ed25519 blob"));
        assert_eq!(structured.first_trusted_at, 123);
        assert_eq!(structured.task_id.as_deref(), Some("task-1"));
    }

    #[test]
    fn a_task_id_change_is_distinct_from_a_key_change_on_the_same_task() {
        assert_ne!(
            normalize_task_id(Some("task-new")),
            normalize_task_id(Some("task-old"))
        );
        assert_eq!(normalize_task_id(Some("  ")), None);
        assert_eq!(normalize_task_id(None), None);
    }
}
