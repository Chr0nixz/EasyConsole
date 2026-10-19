use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client;
use tokio::sync::oneshot;

use russh::keys::ssh_key::{self, HashAlg};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

use crate::ssh::session::{emit_session_event, HOST_KEY_PROMPT_TIMEOUT_SECS};
use crate::trf;
use crate::{app_data_file, load_string_map, write_string_map};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    host_port: String,
    fingerprint: String,
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
}

pub struct PendingHostKeyPrompt {
    tx: oneshot::Sender<bool>,
    pub window_label: String,
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

impl<R: Runtime> client::Handler for EasyConsoleSshClient<R> {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match evaluate_known_host(&self.app, &self.host, self.port, server_public_key) {
            Ok(HostKeyDecision::Match) => Ok(true),
            Ok(HostKeyDecision::Mismatch { .. }) => {
                if let Ok(mut guard) = self.host_key_error.lock() {
                    *guard = Some(trf!(
                        "SSH 主机密钥与已知记录不符（{}:{}）。如确认主机已更换密钥，请在设置中删除该 known host 后重试。",
                        "The SSH host key does not match the known record ({}:{}). If the host really changed its key, delete that known host in Settings and retry.",
                        self.host, self.port
                    ));
                }
                Ok(false)
            }
            Ok(HostKeyDecision::Unknown { fingerprint }) => {
                if !self.allow_host_key_prompt {
                    if let Ok(mut guard) = self.host_key_error.lock() {
                        *guard = Some(trf!(
                            "尚未信任 SSH 主机 {}:{}。请先通过应用内 SSH 确认指纹后再重试。",
                            "The SSH host {}:{} is not trusted yet. Confirm its fingerprint through in-app SSH first, then retry.",
                            self.host, self.port
                        ));
                    }
                    return Ok(false);
                }
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
                        },
                    );
                } else {
                    if let Ok(mut guard) = self.host_key_error.lock() {
                        *guard = Some(trf!(
                            "无法等待主机密钥确认：内部状态已损坏",
                            "Cannot await host key confirmation: internal state is corrupted"
                        ));
                    }
                    return Ok(false);
                }

                let payload = HostKeyPromptPayload {
                    prompt_id: prompt_id.clone(),
                    host: self.host.clone(),
                    port: self.port,
                    fingerprint: fingerprint.clone(),
                };
                let data = serde_json::to_string(&payload).ok();
                emit_session_event(
                    &self.app,
                    &self.window_label,
                    &self.session_id,
                    "host-key-prompt",
                    None,
                    data,
                    Some(trf!(
                        "首次连接 {}:{}，请确认主机指纹后继续。",
                        "First connection to {}:{}. Confirm the host fingerprint to continue.",
                        self.host,
                        self.port
                    )),
                );

                let accepted = match tokio::time::timeout(
                    Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS),
                    rx,
                )
                .await
                {
                    Ok(Ok(value)) => value,
                    Ok(Err(_)) => false,
                    Err(_) => false,
                };

                if !accepted {
                    if let Ok(mut guard) = self.host_key_error.lock() {
                        *guard = Some(trf!(
                            "已拒绝或超时未确认 SSH 主机密钥（{}:{}）。",
                            "The SSH host key was rejected or not confirmed in time ({}:{}).",
                            self.host,
                            self.port
                        ));
                    }
                    return Ok(false);
                }

                if let Err(message) =
                    persist_known_host(&self.app, &self.host, self.port, &fingerprint)
                {
                    if let Ok(mut guard) = self.host_key_error.lock() {
                        *guard = Some(trf!(
                            "无法保存 SSH 主机密钥：{message}",
                            "Failed to save the SSH host key: {message}"
                        ));
                    }
                    return Ok(false);
                }
                Ok(true)
            }
            Err(message) => {
                if let Ok(mut guard) = self.host_key_error.lock() {
                    *guard = Some(trf!(
                        "无法校验 SSH 主机密钥：{message}",
                        "Failed to verify the SSH host key: {message}"
                    ));
                }
                Ok(false)
            }
        }
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
    let path = app_data_file(app, "known-ssh-hosts.json")?;
    let known_hosts = load_string_map(&path)?;
    let key = known_host_key(host, port);
    Ok(evaluate_host_key(&known_hosts, &key, &fingerprint))
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
    let mut known_hosts = load_string_map(&path)?;
    known_hosts.insert(known_host_key(host, port), fingerprint.to_string());
    write_string_map(&path, &known_hosts)
}

#[tauri::command]
pub fn list_known_hosts(app: AppHandle) -> Result<Vec<KnownHostEntry>, String> {
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    let known_hosts = load_string_map(&path)?;
    Ok(known_hosts
        .iter()
        .map(|(k, v)| KnownHostEntry {
            host_port: k.clone(),
            fingerprint: v.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn confirm_known_host(prompt_id: String, accept: bool) -> Result<(), String> {
    let sender = pending_host_key_prompts()
        .lock()
        .map_err(|_| {
            trf!(
                "无法确认主机密钥：内部状态已损坏",
                "Cannot confirm the host key: internal state is corrupted"
            )
        })?
        .remove(&prompt_id)
        .ok_or_else(|| {
            trf!(
                "主机密钥确认请求已失效或超时",
                "The host key confirmation request expired or timed out"
            )
        })?;
    sender.tx.send(accept).map_err(|_| {
        trf!(
            "主机密钥确认通道已关闭",
            "The host key confirmation channel is closed"
        )
    })
}

#[tauri::command]
pub fn remove_known_host(app: AppHandle, host_port: String) -> Result<(), String> {
    let _guard = known_hosts_lock().lock().map_err(|e| {
        trf!(
            "已知主机锁获取失败：{e}",
            "Failed to acquire the known-hosts lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    let mut known_hosts = load_string_map(&path)?;
    known_hosts.remove(&host_port);
    write_string_map(&path, &known_hosts)
}

#[tauri::command]
pub fn clear_known_hosts(app: AppHandle) -> Result<(), String> {
    let _guard = known_hosts_lock().lock().map_err(|e| {
        trf!(
            "已知主机锁获取失败：{e}",
            "Failed to acquire the known-hosts lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    write_string_map(&path, &HashMap::new())
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
}
