use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use std::process::Command;
use russh::keys::ssh_key::{self, HashAlg};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{client, ChannelMsg};
use russh_sftp::client::SftpSession;
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use uuid::Uuid;
#[cfg(desktop)]
use {
    tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    tauri::{
        PhysicalPosition, Position, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    },
};

const SSH_SESSION_EVENT: &str = "ssh-session-event";
#[cfg(desktop)]
const DESKTOP_RUN_DUE_EVENT: &str = "desktop-run-due-scheduled-tasks";
#[cfg(desktop)]
const DESKTOP_CLOSE_REQUESTED_EVENT: &str = "desktop-close-requested";
#[cfg(desktop)]
const APP_SETTINGS_STORAGE_KEY: &str = "easy-console.settings";
#[cfg(desktop)]
const DESKTOP_RUN_DUE_INTERVAL_SECS: u64 = 30;
#[cfg(desktop)]
const TRAY_MENU_LABEL: &str = "tray-menu";
#[cfg(desktop)]
const TRAY_MENU_WIDTH: f64 = 320.0;
#[cfg(desktop)]
const TRAY_MENU_HEIGHT: f64 = 244.0;
const DEFAULT_COLS: u32 = 120;
const DEFAULT_ROWS: u32 = 32;
#[cfg(desktop)]
const VSCODE_KEY_NAME: &str = "easyconsole_vscode_ed25519";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(desktop), allow(dead_code))]
struct SshConnectionRequest {
    host: String,
    port: Option<String>,
    username: Option<String>,
    password: Option<String>,
    task_id: Option<String>,
    task_name: Option<String>,
    cols: Option<u32>,
    rows: Option<u32>,
    connect_timeout_sec: Option<u64>,
    keepalive_interval_sec: Option<u64>,
    term_type: Option<String>,
    ssh_key_path: Option<String>,
    auth_mode: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshSessionEvent {
    session_id: String,
    kind: &'static str,
    data: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnownHostEntry {
    host_port: String,
    fingerprint: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshHistoryEntryValue {
    id: String,
    host: String,
    port: String,
    username: String,
    task_name: String,
    connected_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpEntryValue {
    name: String,
    long_name: String,
    is_dir: bool,
    is_file: bool,
    is_symlink: bool,
    size: u64,
    modified_at: i64,
    permissions: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PortForwardRuleValue {
    id: String,
    #[serde(rename = "type")]
    forward_type: String,
    local_host: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    #[allow(dead_code)]
    enabled: bool,
}

enum SshCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
    SftpList {
        path: String,
        response: oneshot::Sender<Result<Vec<SftpEntryValue>, String>>,
    },
    SftpUpload {
        local_path: String,
        remote_path: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    SftpDownload {
        remote_path: String,
        local_path: String,
        response: oneshot::Sender<Result<(), String>>,
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
        response: oneshot::Sender<Result<(), String>>,
    },
    StopPortForward {
        rule_id: String,
        response: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Default)]
struct SshSessionState {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<SshCommand>>>,
}

#[cfg(desktop)]
#[derive(Default)]
struct DesktopRuntimeState {
    close_to_tray: Mutex<bool>,
    close_prompt_enabled: Mutex<bool>,
    quit_requested: Mutex<bool>,
}

#[derive(Clone)]
struct EasyConsoleSshClient {
    app: AppHandle,
    host: String,
    port: u16,
}

impl client::Handler for EasyConsoleSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(verify_known_host(&self.app, &self.host, self.port, server_public_key).unwrap_or(false))
    }
}

fn app_data_file(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(dir.join(filename))
}

fn load_string_map(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取本地数据：{error}"))?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("本地数据格式无法识别：{error}"))
}

fn write_string_map(path: &Path, data: &HashMap<String, String>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(data).map_err(|error| format!("本地数据序列化失败：{error}"))?;
    fs::write(path, text).map_err(|error| format!("无法写入本地数据：{error}"))
}

fn known_host_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

fn trust_on_first_use(
    known_hosts: &mut HashMap<String, String>,
    key: String,
    fingerprint: String,
) -> bool {
    if let Some(known_fingerprint) = known_hosts.get(&key) {
        return known_fingerprint == &fingerprint;
    }
    known_hosts.insert(key, fingerprint);
    true
}

fn verify_known_host(
    app: &AppHandle,
    host: &str,
    port: u16,
    server_public_key: &ssh_key::PublicKey,
) -> Result<bool, String> {
    let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
    let path = app_data_file(app, "known-ssh-hosts.json")?;
    let mut known_hosts = load_string_map(&path)?;
    let key = known_host_key(host, port);
    let trusted = trust_on_first_use(&mut known_hosts, key, fingerprint);
    if trusted {
        write_string_map(&path, &known_hosts)?;
    }
    Ok(trusted)
}

fn emit_session_event(
    app: &AppHandle,
    session_id: &str,
    kind: &'static str,
    data: Option<String>,
    message: Option<String>,
) {
    let _ = app.emit(
        SSH_SESSION_EVENT,
        SshSessionEvent {
            session_id: session_id.to_string(),
            kind,
            data,
            message,
        },
    );
}

fn remove_session(state: &Arc<SshSessionState>, session_id: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.remove(session_id);
    }
}

fn validate_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("SSH Host 为空，无法建立连接".to_string());
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Err("SSH Host 包含不支持的字符".to_string());
    }
    Ok(host.to_string())
}

fn parse_port(port: Option<&str>) -> Result<u16, String> {
    let Some(port) = port.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(22);
    };
    port.parse::<u16>()
        .map_err(|_| "SSH Port 不是有效数字".to_string())
}

fn validate_username(username: Option<&str>) -> Result<Option<String>, String> {
    let username = username.map(str::trim).filter(|value| !value.is_empty());
    if let Some(username) = username {
        if !username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        {
            return Err("SSH Username 包含不支持的字符".to_string());
        }
        return Ok(Some(username.to_string()));
    }
    Ok(None)
}

#[cfg(desktop)]
fn require_username(username: Option<&str>) -> Result<String, String> {
    validate_username(username)?.ok_or_else(|| "SSH Username 为空，无法建立连接".to_string())
}

#[cfg(desktop)]
fn require_password(password: Option<&str>) -> Result<String, String> {
    password
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "SSH Password 为空，无法为 VS Code 配置免密登录".to_string())
}

#[cfg(desktop)]
fn sanitize_alias_part(value: &str) -> String {
    let mut sanitized = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch.to_ascii_lowercase());
        } else {
            sanitized.push('-');
        }
    }
    sanitized
        .trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>()
}

#[cfg(desktop)]
fn vscode_ssh_alias(request: &SshConnectionRequest) -> Result<String, String> {
    let host = validate_host(&request.host)?;
    let username = require_username(request.username.as_deref())?;
    let port = parse_port(request.port.as_deref())?;
    let source = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{username}-{host}-{port}"));
    let suffix = sanitize_alias_part(&source);
    if suffix.is_empty() {
        return Err("无法生成 VS Code SSH Host 别名".to_string());
    }
    Ok(format!("easyconsole-{suffix}"))
}

fn validate_external_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("外部链接为空，无法打开".to_string());
    }
    if url.chars().any(char::is_control) {
        return Err("外部链接包含不支持的字符".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持打开 http 或 https 链接".to_string());
    }
    Ok(url.to_string())
}

#[cfg(desktop)]
fn validate_local_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("本地路径为空，无法打开".to_string());
    }
    if path.chars().any(char::is_control) {
        return Err("本地路径包含不支持的字符".to_string());
    }
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("本地路径不存在".to_string());
    }
    Ok(path)
}

#[cfg(all(desktop, target_os = "windows"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开本地路径：{error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开本地路径：{error}"))
}

#[cfg(all(desktop, target_os = "linux"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开本地路径：{error}"))
}

#[cfg(all(desktop, target_os = "windows"))]
fn reveal_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开所在文件夹：{error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn reveal_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开所在文件夹：{error}"))
}

#[cfg(all(desktop, target_os = "linux"))]
fn reveal_path_with_system(path: &Path) -> Result<(), String> {
    let directory = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开所在文件夹：{error}"))
}

#[cfg(desktop)]
fn user_ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位当前用户主目录，不能写入 SSH 配置".to_string())?;
    Ok(home.join(".ssh"))
}

#[cfg(desktop)]
fn ensure_vscode_key(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let key_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("ssh");
    fs::create_dir_all(&key_dir).map_err(|error| format!("无法创建 SSH key 目录：{error}"))?;

    let private_key = key_dir.join(VSCODE_KEY_NAME);
    let public_key = key_dir.join(format!("{VSCODE_KEY_NAME}.pub"));
    if !private_key.exists() {
        if public_key.exists() {
            let _ = fs::remove_file(&public_key);
        }
        let status = Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-C", "easyconsole-vscode", "-f"])
            .arg(&private_key)
            .status()
            .map_err(|error| format!("无法运行 ssh-keygen：{error}"))?;
        if !status.success() {
            return Err("ssh-keygen 生成 VS Code 专用 SSH key 失败".to_string());
        }
    } else if !public_key.exists() {
        let output = Command::new("ssh-keygen")
            .args(["-y", "-f"])
            .arg(&private_key)
            .output()
            .map_err(|error| format!("无法从私钥恢复 SSH 公钥：{error}"))?;
        if !output.status.success() {
            return Err("ssh-keygen 恢复 VS Code 专用 SSH 公钥失败".to_string());
        }
        fs::write(&public_key, output.stdout)
            .map_err(|error| format!("无法写入 SSH 公钥：{error}"))?;
    }

    let public_key_text =
        fs::read_to_string(&public_key).map_err(|error| format!("无法读取 SSH 公钥：{error}"))?;
    let public_key_text = public_key_text.trim().to_string();
    if public_key_text.is_empty() {
        return Err("SSH 公钥为空，无法配置免密登录".to_string());
    }

    Ok((private_key, public_key_text))
}

#[cfg(desktop)]
fn ssh_config_identity_path(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('"', "\\\"")
    )
}

#[cfg(desktop)]
fn write_vscode_ssh_config(
    request: &SshConnectionRequest,
    alias: &str,
    identity_file: &Path,
) -> Result<(), String> {
    let host = validate_host(&request.host)?;
    let username = require_username(request.username.as_deref())?;
    let port = parse_port(request.port.as_deref())?;
    let ssh_dir = user_ssh_dir()?;
    fs::create_dir_all(&ssh_dir).map_err(|error| format!("无法创建本机 SSH 配置目录：{error}"))?;
    let config_path = ssh_dir.join("config");
    let current = fs::read_to_string(&config_path).unwrap_or_default();
    let start_marker = format!("# >>> EasyConsole {alias}");
    let end_marker = format!("# <<< EasyConsole {alias}");
    let mut next = String::new();
    let mut skipping = false;

    for line in current.lines() {
        if line.trim() == start_marker {
            skipping = true;
            continue;
        }
        if line.trim() == end_marker {
            skipping = false;
            continue;
        }
        if !skipping {
            next.push_str(line);
            next.push('\n');
        }
    }

    if !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&format!(
        "{start_marker}\nHost {alias}\n  HostName {host}\n  User {username}\n  Port {port}\n  IdentityFile {}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n{end_marker}\n",
        ssh_config_identity_path(identity_file),
    ));

    fs::write(&config_path, next).map_err(|error| format!("无法写入本机 SSH 配置：{error}"))
}

#[cfg(desktop)]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(all(desktop, target_os = "windows"))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器：{error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器：{error}"))
}

#[cfg(all(desktop, target_os = "linux"))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开浏览器：{error}"))
}

#[cfg(desktop)]
fn ssh_args(request: &SshConnectionRequest) -> Result<Vec<String>, String> {
    let host = validate_host(&request.host)?;
    let mut args = Vec::new();
    if let Some(port) = request
        .port
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !port.chars().all(|ch| ch.is_ascii_digit()) {
            return Err("SSH Port 不是有效数字".to_string());
        }
        args.push("-p".to_string());
        args.push(port.to_string());
    }

    let username = validate_username(request.username.as_deref())?;
    let target = username
        .map(|username| format!("{username}@{host}"))
        .unwrap_or(host);
    args.push(target);
    Ok(args)
}

#[cfg(all(desktop, target_os = "windows"))]
fn spawn_ssh_terminal(request: &SshConnectionRequest) -> Result<(), String> {
    let args = ssh_args(request)?;
    let mut wt_args = vec![
        "new-tab".to_string(),
        "--title".to_string(),
        request
            .task_name
            .clone()
            .unwrap_or_else(|| "EasyConsole SSH".to_string()),
        "ssh".to_string(),
    ];
    wt_args.extend(args);

    match Command::new("wt").args(&wt_args).spawn() {
        Ok(_) => Ok(()),
        Err(_) => {
            let mut powershell_args = vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                "ssh".to_string(),
            ];
            powershell_args.extend(ssh_args(request)?);
            Command::new("powershell")
                .args(&powershell_args)
                .spawn()
                .map(|_| ())
                .map_err(|error| format!("无法打开系统终端：{error}"))
        }
    }
}

#[cfg(all(desktop, target_os = "macos"))]
fn spawn_ssh_terminal(request: &SshConnectionRequest) -> Result<(), String> {
    let args = ssh_args(request)?;
    let escaped = args
        .iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ");
    Command::new("osascript")
        .args([
            "-e",
            &format!("tell application \"Terminal\" to do script \"ssh {escaped}\""),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开系统终端：{error}"))
}

#[cfg(all(desktop, target_os = "linux"))]
fn spawn_ssh_terminal(request: &SshConnectionRequest) -> Result<(), String> {
    let args = ssh_args(request)?;
    let terminals = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
    ];
    for terminal in terminals {
        let mut command = Command::new(terminal);
        match terminal {
            "gnome-terminal" | "xfce4-terminal" => {
                command.args(["--", "ssh"]);
            }
            "konsole" => {
                command.args(["-e", "ssh"]);
            }
            _ => {
                command.args(["-e", "ssh"]);
            }
        }
        command.args(&args);
        if command.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("无法打开系统终端，请确认本机已安装终端和 ssh 客户端".to_string())
}

#[cfg(desktop)]
fn spawn_vscode_ssh(alias: &str) -> Result<(), String> {
    let authority = format!("ssh-remote+{alias}");

    #[cfg(target_os = "windows")]
    let code_commands = ["code.cmd", "code.exe", "code"];
    #[cfg(not(target_os = "windows"))]
    let code_commands = ["code"];

    for command in code_commands {
        if Command::new(command)
            .args(["--remote", authority.as_str()])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    let uri = format!("vscode://vscode-remote/{authority}/");
    open_url_in_browser(&uri).map_err(|error| format!("无法打开 VS Code：{error}"))
}

#[cfg(desktop)]
async fn install_vscode_public_key(
    app: &AppHandle,
    request: &SshConnectionRequest,
    public_key: &str,
) -> Result<(), String> {
    let host = validate_host(&request.host)?;
    let port = parse_port(request.port.as_deref())?;
    let username = require_username(request.username.as_deref())?;
    let password = require_password(request.password.as_deref())?;
    let quoted_key = shell_single_quote(public_key);
    let command = format!(
        "umask 077; mkdir -p \"$HOME/.ssh\" && touch \"$HOME/.ssh/authorized_keys\" && (grep -qxF {quoted_key} \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' {quoted_key} >> \"$HOME/.ssh/authorized_keys\") && chmod 700 \"$HOME/.ssh\" && chmod 600 \"$HOME/.ssh/authorized_keys\"",
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 0,
        ..<_>::default()
    });
    let handler = EasyConsoleSshClient {
        app: app.clone(),
        host: host.clone(),
        port,
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| "SSH 连接超时，无法配置 VS Code 免密，请检查网络和主机是否可达".to_string())?
    .map_err(|error| format!("SSH 连接失败，无法配置 VS Code 免密：{error}"))?;

    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(|error| format!("SSH 认证失败，无法配置 VS Code 免密：{error}"))?;
    if !auth.success() {
        return Err("SSH 认证失败，无法配置 VS Code 免密：用户名或密码不正确".to_string());
    }

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话打开失败，无法配置 VS Code 免密：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("远端免密配置命令执行失败：{error}"))?;

    let mut output = String::new();
    let mut exit_status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            ChannelMsg::ExitStatus {
                exit_status: status,
            } => {
                exit_status = Some(status);
            }
            ChannelMsg::Close | ChannelMsg::Eof => break,
            _ => {}
        }
    }

    let _ = channel.close().await;
    let _ = session
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    if exit_status.unwrap_or(1) != 0 {
        let output = output.trim();
        if output.is_empty() {
            return Err("远端 authorized_keys 更新失败".to_string());
        }
        return Err(format!("远端 authorized_keys 更新失败：{output}"));
    }

    Ok(())
}

#[cfg(desktop)]
async fn prepare_vscode_ssh(
    app: &AppHandle,
    request: &SshConnectionRequest,
) -> Result<String, String> {
    let alias = vscode_ssh_alias(request)?;
    let (identity_file, public_key) = ensure_vscode_key(app)?;
    install_vscode_public_key(app, request, &public_key).await?;
    write_vscode_ssh_config(request, &alias, &identity_file)?;
    Ok(alias)
}

async fn socks5_handshake(
    stream: &mut tokio::net::TcpStream,
) -> Result<(String, u16), String> {
    // Greeting: version(1) + num_methods(1) + methods(N)
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|e| format!("SOCKS5 读取问候失败：{e}"))?;
    if greeting[0] != 5 {
        return Err("SOCKS5 版本不匹配".to_string());
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("SOCKS5 读取方法失败：{e}"))?;
    // Reply: no auth
    stream
        .write_all(&[5, 0])
        .await
        .map_err(|e| format!("SOCKS5 写入方法回复失败：{e}"))?;

    // Request: version(1) + cmd(1) + rsv(1) + atyp(1) + addr + port(2)
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("SOCKS5 读取请求失败：{e}"))?;
    if header[0] != 5 {
        return Err("SOCKS5 请求版本不匹配".to_string());
    }
    if header[1] != 1 {
        // Only CONNECT supported
        let _ = stream
            .write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
            .await;
        return Err("SOCKS5 仅支持 CONNECT 命令".to_string());
    }
    let dest_host = match header[3] {
        1 => {
            // IPv4
            let mut addr = [0u8; 4];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|e| format!("SOCKS5 读取 IPv4 地址失败：{e}"))?;
            format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
        }
        3 => {
            // Domain
            let mut len_buf = [0u8; 1];
            stream
                .read_exact(&mut len_buf)
                .await
                .map_err(|e| format!("SOCKS5 读取域名长度失败：{e}"))?;
            let mut domain = vec![0u8; len_buf[0] as usize];
            stream
                .read_exact(&mut domain)
                .await
                .map_err(|e| format!("SOCKS5 读取域名失败：{e}"))?;
            String::from_utf8_lossy(&domain).to_string()
        }
        4 => {
            // IPv6
            let mut addr = [0u8; 16];
            stream
                .read_exact(&mut addr)
                .await
                .map_err(|e| format!("SOCKS5 读取 IPv6 地址失败：{e}"))?;
            format!("[{:x}]", u128::from_be_bytes(addr))
        }
        _ => {
            let _ = stream
                .write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0])
                .await;
            return Err("SOCKS5 不支持的地址类型".to_string());
        }
    };
    let mut port_buf = [0u8; 2];
    stream
        .read_exact(&mut port_buf)
        .await
        .map_err(|e| format!("SOCKS5 读取端口失败：{e}"))?;
    let dest_port = u16::from_be_bytes(port_buf);

    // Reply: success
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| format!("SOCKS5 写入回复失败：{e}"))?;

    Ok((dest_host, dest_port))
}

/// Resolve a user-supplied SFTP path that may use the "~" home shortcut.
/// SFTP protocol does not expand "~" (that's a shell convention), so we
/// canonicalize(".") once to get the absolute home directory and substitute.
async fn resolve_sftp_path(sftp: &SftpSession, path: &str) -> Result<String, String> {
    if path == "~" || path == "~/" {
        return sftp.canonicalize(".").await.map_err(|e| format!("SFTP 解析家目录失败：{e}"));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = sftp.canonicalize(".").await.map_err(|e| format!("SFTP 解析家目录失败：{e}"))?;
        let rest = rest.trim_start_matches('/');
        return Ok(if home.ends_with('/') {
            format!("{home}{rest}")
        } else {
            format!("{home}/{rest}")
        });
    }
    Ok(path.to_string())
}

async fn run_russh_session(
    app: AppHandle,
    session_id: String,
    request: SshConnectionRequest,
    mut rx: mpsc::UnboundedReceiver<SshCommand>,
) -> Result<(), String> {
    let host = validate_host(&request.host)?;
    let port = parse_port(request.port.as_deref())?;
    let username = validate_username(request.username.as_deref())?
        .ok_or_else(|| "SSH Username 为空，无法建立连接".to_string())?;
    let password = request
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let auth_mode = request.auth_mode.as_deref().unwrap_or("password");
    let cols = request.cols.unwrap_or(DEFAULT_COLS).max(1);
    let rows = request.rows.unwrap_or(DEFAULT_ROWS).max(1);
    let keepalive = Duration::from_secs(request.keepalive_interval_sec.unwrap_or(20));
    let connect_timeout = Duration::from_secs(request.connect_timeout_sec.unwrap_or(15));
    let term_type = request.term_type.as_deref().unwrap_or("xterm-256color");

    // In password mode, password is required. In key mode, it's optional (used as passphrase).
    if auth_mode == "password" {
        if password.is_none() {
            return Err("SSH Password 为空，无法自动登录".to_string());
        }
    }

    emit_session_event(
        &app,
        &session_id,
        "status",
            None,
            Some(format!("正在连接 {host}:{port}")),
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(keepalive),
        keepalive_max: 0,
        ..<_>::default()
    });
    let handler = EasyConsoleSshClient {
        app: app.clone(),
        host: host.clone(),
        port,
    };
    let mut session = tokio::time::timeout(
        connect_timeout,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| "SSH 连接超时，请检查网络和主机是否可达".to_string())?
    .map_err(|error| format!("SSH 连接失败：{error}"))?;

    let auth_success = if auth_mode == "key" {
        let key_path = request.ssh_key_path.as_deref()
            .ok_or_else(|| "SSH 密钥路径为空".to_string())?;
        let passphrase = password.as_deref();
        let key_pair = russh::keys::load_secret_key(key_path, passphrase)
            .map_err(|e| format!("SSH 密钥加载失败：{e}"))?;
        let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha256));
        session.authenticate_publickey(&username, key_with_hash).await
            .map_err(|error| format!("SSH 密钥认证失败：{error}"))?
    } else {
        let pwd = password.as_deref()
            .ok_or_else(|| "SSH Password 为空，无法自动登录".to_string())?;
        session.authenticate_password(&username, pwd).await
            .map_err(|error| format!("SSH 认证失败：{error}"))?
    };
    if !auth_success.success() {
        return Err(if auth_mode == "key" {
            "SSH 密钥认证失败：密钥被拒绝".to_string()
        } else {
            "SSH 认证失败：用户名或密码不正确".to_string()
        });
    }

    // Wrap in Arc after authentication so it can be shared with spawned port
    // forwarding tasks. Authentication methods require &mut self, so the Arc
    // must come after all mutable calls.
    let session = Arc::new(session);

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话打开失败：{error}"))?;
    channel
        .request_pty(false, term_type, cols, rows, 0, 0, &[])
        .await
        .map_err(|error| format!("SSH PTY 请求失败：{error}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| format!("SSH Shell 请求失败：{error}"))?;

    emit_session_event(
        &app,
        &session_id,
        "status",
        None,
        Some("SSH 已连接".to_string()),
    );

    let mut output_buffer = String::new();
    let mut flush_interval = tokio::time::interval(Duration::from_millis(16));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut sftp_session: Option<SftpSession> = None;
    let mut port_forward_handles: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        tokio::select! {
            command = rx.recv() => {
                match command {
                    Some(SshCommand::Write(data)) => {
                        channel
                            .data(data.as_bytes())
                            .await
                            .map_err(|error| format!("SSH 写入失败：{error}"))?;
                    }
                    Some(SshCommand::Resize { cols, rows }) => {
                        channel
                            .window_change(cols.max(1), rows.max(1), 0, 0)
                            .await
                            .map_err(|error| format!("SSH 窗口尺寸更新失败：{error}"))?;
                    }
                    Some(SshCommand::Close) | None => {
                        if !output_buffer.is_empty() {
                            emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                        }
                        sftp_session.take();
                        for (_, handle) in port_forward_handles.drain() {
                            handle.abort();
                        }
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                        break;
                    }
                    Some(SshCommand::SftpList { path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let effective_path = resolve_sftp_path(sftp, &path).await?;
                            let mut entries = Vec::new();
                            let mut read_dir = sftp.read_dir(&effective_path).await
                                .map_err(|e| format!("SFTP 列目录失败：{e}"))?;
                            while let Some(entry) = read_dir.next() {
                                let name = entry.file_name();
                                let file_type = entry.file_type();
                                let metadata = entry.metadata();
                                let size = metadata.size.unwrap_or(0);
                                let modified_at = metadata.mtime.map(|t| (t as i64) * 1000).unwrap_or(0);
                                let perms = metadata.permissions.unwrap_or(0);
                                let permissions = format!("{perms:04o}");
                                let is_dir = file_type.is_dir();
                                let is_file = file_type.is_file();
                                let is_symlink = file_type.is_symlink();
                                let long_name = format!("{} {} {}", permissions, size, name);
                                entries.push(SftpEntryValue { name, long_name, is_dir, is_file, is_symlink, size, modified_at, permissions });
                            }
                            Ok::<Vec<SftpEntryValue>, String>(entries)
                        }.await;
                        match result {
                            Ok(entries) => { let _ = response.send(Ok(entries)); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::SftpUpload { local_path, remote_path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let remote_path = resolve_sftp_path(sftp, &remote_path).await?;
                            let data = tokio::fs::read(&local_path).await
                                .map_err(|e| format!("读取本地文件失败：{e}"))?;
                            let total = data.len() as u64;
                            emit_session_event(&app, &session_id, "sftp-progress", Some(format!(r#"{{"transferred":0,"total":{total}}}"#)), None);
                            sftp.write(&remote_path, &data).await
                                .map_err(|e| format!("SFTP 上传失败：{e}"))?;
                            emit_session_event(&app, &session_id, "sftp-progress", Some(format!(r#"{{"transferred":{total},"total":{total}}}"#)), None);
                            Ok::<(), String>(())
                        }.await;
                        match result {
                            Ok(()) => { let _ = response.send(Ok(())); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::SftpDownload { remote_path, local_path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let remote_path = resolve_sftp_path(sftp, &remote_path).await?;
                            let data = sftp.read(&remote_path).await
                                .map_err(|e| format!("SFTP 下载失败：{e}"))?;
                            let total = data.len() as u64;
                            emit_session_event(&app, &session_id, "sftp-progress", Some(format!(r#"{{"transferred":{total},"total":{total}}}"#)), None);
                            tokio::fs::write(&local_path, &data).await
                                .map_err(|e| format!("写入本地文件失败：{e}"))?;
                            Ok::<(), String>(())
                        }.await;
                        match result {
                            Ok(()) => { let _ = response.send(Ok(())); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::SftpDelete { path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let path = resolve_sftp_path(sftp, &path).await?;
                            let metadata = sftp.metadata(&path).await
                                .map_err(|e| format!("SFTP 获取文件信息失败：{e}"))?;
                            if metadata.is_dir() {
                                sftp.remove_dir(&path).await
                                    .map_err(|e| format!("SFTP 删除目录失败：{e}"))?;
                            } else {
                                sftp.remove_file(&path).await
                                    .map_err(|e| format!("SFTP 删除文件失败：{e}"))?;
                            }
                            Ok::<(), String>(())
                        }.await;
                        match result {
                            Ok(()) => { let _ = response.send(Ok(())); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::SftpRename { old_path, new_path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let old_path = resolve_sftp_path(sftp, &old_path).await?;
                            let new_path = resolve_sftp_path(sftp, &new_path).await?;
                            sftp.rename(&old_path, &new_path).await
                                .map_err(|e| format!("SFTP 重命名失败：{e}"))?;
                            Ok::<(), String>(())
                        }.await;
                        match result {
                            Ok(()) => { let _ = response.send(Ok(())); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::SftpMkdir { path, response }) => {
                        let result = async {
                            if sftp_session.is_none() {
                                let sftp_channel = session.channel_open_session().await
                                    .map_err(|e| format!("SFTP 通道打开失败：{e}"))?;
                                sftp_channel.request_subsystem(true, "sftp").await
                                    .map_err(|e| format!("SFTP 子系统请求失败：{e}"))?;
                                sftp_session = Some(SftpSession::new(sftp_channel.into_stream()).await
                                    .map_err(|e| format!("SFTP 会话创建失败：{e}"))?);
                            }
                            let sftp = sftp_session.as_ref().unwrap();
                            let path = resolve_sftp_path(sftp, &path).await?;
                            sftp.create_dir(&path).await
                                .map_err(|e| format!("SFTP 创建目录失败：{e}"))?;
                            Ok::<(), String>(())
                        }.await;
                        match result {
                            Ok(()) => { let _ = response.send(Ok(())); }
                            Err(e) => {
                                sftp_session.take();
                                let _ = response.send(Err(e));
                            }
                        }
                    }
                    Some(SshCommand::StartPortForward { rule, response }) => {
                        let rule_id = rule.id.clone();
                        if rule.forward_type == "remote" {
                            let _ = response.send(Err("远程端口转发 (-R) 暂不支持".to_string()));
                            continue;
                        }
                        if port_forward_handles.contains_key(&rule_id) {
                            let _ = response.send(Err("端口转发规则已在运行".to_string()));
                            continue;
                        }
                        let session_clone = session.clone();
                        let app_clone = app.clone();
                        let session_id_clone = session_id.clone();
                        let rule_clone = rule.clone();
                        let handle = tokio::spawn(async move {
                            let listener = match tokio::net::TcpListener::bind((
                                rule_clone.local_host.as_str(),
                                rule_clone.local_port,
                            ))
                            .await
                            {
                                Ok(l) => l,
                                Err(e) => {
                                    emit_session_event(
                                        &app_clone,
                                        &session_id_clone,
                                        "port-forward-status",
                                        Some(
                                            serde_json::json!({
                                                "ruleId": rule_clone.id,
                                                "active": false,
                                                "error": format!("{e}"),
                                            })
                                            .to_string(),
                                        ),
                                        None,
                                    );
                                    return;
                                }
                            };
                            emit_session_event(
                                &app_clone,
                                &session_id_clone,
                                "port-forward-status",
                                Some(
                                    serde_json::json!({
                                        "ruleId": rule_clone.id,
                                        "active": true,
                                    })
                                    .to_string(),
                                ),
                                None,
                            );
                            let is_dynamic = rule_clone.forward_type == "dynamic";
                            let remote_host = rule_clone.remote_host.clone();
                            let remote_port = rule_clone.remote_port;
                            loop {
                                let (mut tcp_stream, peer_addr) = match listener.accept().await {
                                    Ok(conn) => conn,
                                    Err(_) => break,
                                };
                                let session = session_clone.clone();
                                let app = app_clone.clone();
                                let session_id = session_id_clone.clone();
                                let rule_id = rule_clone.id.clone();
                                let remote_host = remote_host.clone();
                                tokio::spawn(async move {
                                    let (dest_host, dest_port) = if is_dynamic {
                                        match socks5_handshake(&mut tcp_stream).await {
                                            Ok(result) => result,
                                            Err(_) => return,
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
                                        Ok(ch) => ch,
                                        Err(e) => {
                                            emit_session_event(
                                                &app,
                                                &session_id,
                                                "port-forward-status",
                                                Some(
                                                    serde_json::json!({
                                                        "ruleId": rule_id,
                                                        "active": false,
                                                        "error": format!("{e}"),
                                                    })
                                                    .to_string(),
                                                ),
                                                None,
                                            );
                                            return;
                                        }
                                    };
                                    let mut channel_stream = channel.into_stream();
                                    let _ = copy_bidirectional(&mut tcp_stream, &mut channel_stream).await;
                                });
                            }
                        });
                        port_forward_handles.insert(rule_id, handle);
                        let _ = response.send(Ok(()));
                    }
                    Some(SshCommand::StopPortForward { rule_id, response }) => {
                        if let Some(handle) = port_forward_handles.remove(&rule_id) {
                            handle.abort();
                        }
                        emit_session_event(
                            &app,
                            &session_id,
                            "port-forward-status",
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
            message = channel.wait() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        output_buffer.push_str(&String::from_utf8_lossy(&data));
                        if output_buffer.len() >= 8192 {
                            emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        if !output_buffer.is_empty() {
                            emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                        }
                        emit_session_event(&app, &session_id, "status", None, Some(format!("SSH 进程已退出，状态码 {exit_status}")));
                    }
                    ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                        if !output_buffer.is_empty() {
                            emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                        }
                        emit_session_event(
                            &app,
                            &session_id,
                            "status",
                            None,
                            Some(format!("SSH 进程收到信号 {signal_name:?}: {error_message}")),
                        );
                    }
                    ChannelMsg::Close | ChannelMsg::Eof => {
                        if !output_buffer.is_empty() {
                            emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                        }
                        break;
                    }
                    _ => {}
                }
            }
            _ = flush_interval.tick() => {
                if !output_buffer.is_empty() {
                    emit_session_event(&app, &session_id, "output", Some(std::mem::take(&mut output_buffer)), None);
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn open_ssh_session(
    app: AppHandle,
    state: State<'_, Arc<SshSessionState>>,
    request: SshConnectionRequest,
) -> Result<String, String> {
    validate_host(&request.host)?;
    parse_port(request.port.as_deref())?;
    validate_username(request.username.as_deref())?;

    let session_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    state
        .sessions
        .lock()
        .map_err(|_| "SSH 会话状态已损坏".to_string())?
        .insert(session_id.clone(), tx);

    let task_state = Arc::clone(&state);
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            run_russh_session(app.clone(), task_session_id.clone(), request, rx).await
        {
            emit_session_event(&app, &task_session_id, "error", None, Some(error));
        }
        remove_session(&task_state, &task_session_id);
        emit_session_event(
            &app,
            &task_session_id,
            "closed",
            None,
            Some("SSH 会话已关闭".to_string()),
        );
    });

    Ok(session_id)
}

fn send_session_command(
    state: State<'_, Arc<SshSessionState>>,
    session_id: &str,
    command: SshCommand,
) -> Result<(), String> {
    let sender = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "SSH 会话状态已损坏".to_string())?;
        sessions.get(session_id).cloned()
    }
    .ok_or_else(|| "SSH 会话不存在或已关闭".to_string())?;

    sender
        .send(command)
        .map_err(|_| "SSH 会话已关闭".to_string())
}

async fn send_session_command_with_response<T>(
    state: State<'_, Arc<SshSessionState>>,
    session_id: &str,
    build_command: impl FnOnce(oneshot::Sender<Result<T, String>>) -> SshCommand,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let command = build_command(tx);
    send_session_command(state, session_id, command)?;
    rx.await
        .map_err(|_| "SSH 命令响应通道已关闭".to_string())?
}

fn runtime_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, "runtime-storage.json")
}

/// Global lock serializing all runtime-storage read-modify-write cycles.
/// Prevents lost-update races when concurrent callers (e.g. run-log append and
/// scheduled-task persist) write to the same file.
static RUNTIME_STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn runtime_storage_lock() -> &'static Mutex<()> {
    RUNTIME_STORAGE_LOCK.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
fn runtime_storage_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let _guard = runtime_storage_lock()
        .lock()
        .map_err(|e| format!("本地数据锁获取失败：{e}"))?;
    let path = runtime_storage_path(&app)?;
    let data = load_string_map(&path)?;
    Ok(data.get(&key).cloned())
}

#[tauri::command]
fn runtime_storage_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let _guard = runtime_storage_lock()
        .lock()
        .map_err(|e| format!("本地数据锁获取失败：{e}"))?;
    let path = runtime_storage_path(&app)?;
    let mut data = load_string_map(&path)?;
    data.insert(key, value);
    write_string_map(&path, &data)
}

#[tauri::command]
fn runtime_storage_remove(app: AppHandle, key: String) -> Result<(), String> {
    let _guard = runtime_storage_lock()
        .lock()
        .map_err(|e| format!("本地数据锁获取失败：{e}"))?;
    let path = runtime_storage_path(&app)?;
    let mut data = load_string_map(&path)?;
    data.remove(&key);
    write_string_map(&path, &data)
}

#[cfg(desktop)]
const KEYCHAIN_SERVICE: &str = "easy-console";

#[cfg(desktop)]
#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain entry lookup failed: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain get failed: {e}")),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain entry lookup failed: {e}"))?;
    entry.set_password(&value).map_err(|e| format!("keychain set failed: {e}"))
}

#[cfg(desktop)]
#[tauri::command]
fn keychain_remove(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain entry lookup failed: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain remove failed: {e}")),
    }
}

/// Reads `desktopCloseToTray` and `desktopClosePrompt` from `runtime-storage.json`
/// in a single file read + parse, instead of two separate passes.
/// Returns `(close_to_tray, close_prompt)` with defaults `false` and `true`.
#[cfg(desktop)]
fn read_close_settings(app: &AppHandle) -> Result<(bool, bool), String> {
    let path = runtime_storage_path(app)?;
    let data = load_string_map(&path)?;
    let Some(raw) = data.get(APP_SETTINGS_STORAGE_KEY) else {
        return Ok((false, true));
    };
    let value = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("invalid app settings json: {error}"))?;
    let close_to_tray = value
        .get("desktopCloseToTray")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let close_prompt = value
        .get("desktopClosePrompt")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    Ok((close_to_tray, close_prompt))
}

#[cfg(desktop)]
fn set_close_to_tray_state(state: &Arc<DesktopRuntimeState>, enabled: bool) -> Result<(), String> {
    let mut close_to_tray = state
        .close_to_tray
        .lock()
        .map_err(|_| "桌面运行状态已损坏".to_string())?;
    *close_to_tray = enabled;
    Ok(())
}

#[cfg(desktop)]
fn set_close_prompt_state(state: &Arc<DesktopRuntimeState>, enabled: bool) -> Result<(), String> {
    let mut close_prompt_enabled = state
        .close_prompt_enabled
        .lock()
        .map_err(|_| "桌面关闭确认状态已损坏".to_string())?;
    *close_prompt_enabled = enabled;
    Ok(())
}

#[cfg(desktop)]
fn get_close_to_tray_state(state: &Arc<DesktopRuntimeState>) -> bool {
    state
        .close_to_tray
        .lock()
        .map(|value| *value)
        .unwrap_or(false)
}

#[cfg(desktop)]
fn get_close_prompt_state(state: &Arc<DesktopRuntimeState>) -> bool {
    state
        .close_prompt_enabled
        .lock()
        .map(|value| *value)
        .unwrap_or(true)
}

#[cfg(desktop)]
fn set_quit_requested(state: &Arc<DesktopRuntimeState>, requested: bool) {
    if let Ok(mut value) = state.quit_requested.lock() {
        *value = requested;
    }
}

#[cfg(desktop)]
fn is_quit_requested(state: &Arc<DesktopRuntimeState>) -> bool {
    state.quit_requested.lock().map(|value| *value).unwrap_or(false)
}

#[cfg(desktop)]
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg(desktop)]
fn hide_tray_menu(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = window.hide();
    }
}

#[cfg(desktop)]
fn ensure_tray_menu_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(TRAY_MENU_LABEL).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        TRAY_MENU_LABEL,
        WebviewUrl::App("index.html#/tray-menu".into()),
    )
    .title("EasyConsole")
    .inner_size(TRAY_MENU_WIDTH, TRAY_MENU_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .shadow(true)
    .build()?;

    if let Some(icon) = app.default_window_icon().cloned() {
        window.set_icon(icon)?;
    }

    Ok(())
}

#[cfg(desktop)]
fn show_tray_menu(app: &AppHandle, position: PhysicalPosition<f64>) {
    if let Err(error) = ensure_tray_menu_window(app) {
        log::warn!("failed to create tray menu window: {error}");
        return;
    }

    let x = (position.x - TRAY_MENU_WIDTH + 16.0).max(8.0);
    let y = (position.y - TRAY_MENU_HEIGHT - 8.0).max(8.0);
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(x as i32, y as i32)));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    // Tray menu window is created lazily by `show_tray_menu` on first right-click,
    // avoiding a hidden webview at startup.
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("EasyConsole")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;

    let handle = app.handle().clone();
    app.on_tray_icon_event(move |_app, event| match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
        | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => show_main_window(&handle),
        TrayIconEvent::Click {
            button: MouseButton::Right,
            button_state: MouseButtonState::Up,
            position,
            ..
        } => show_tray_menu(&handle, position),
        _ => {}
    });
    Ok(())
}

#[cfg(desktop)]
fn start_desktop_run_due_timer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(DESKTOP_RUN_DUE_INTERVAL_SECS));
        loop {
            interval.tick().await;
            let _ = app.emit(DESKTOP_RUN_DUE_EVENT, ());
        }
    });
}

#[tauri::command]
fn ssh_write(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Write(data))
}

#[tauri::command]
fn ssh_resize(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Resize { cols, rows })
}

#[tauri::command]
fn ssh_close(state: State<'_, Arc<SshSessionState>>, session_id: String) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Close)
}

/// Open a standalone SSH terminal window. The connection request is passed
/// via URL hash fragment so the new webview can bootstrap its own session
/// independently of the main window.
#[cfg(desktop)]
#[tauri::command]
fn open_ssh_window(app: AppHandle, request: SshConnectionRequest) -> Result<(), String> {
    let label = format!(
        "ssh-{}",
        request
            .task_id
            .as_deref()
            .map(str::to_ascii_lowercase)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    );

    // If a window with this label already exists, just focus it.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let json = serde_json::to_string(&request)
        .map_err(|e| format!("SSH 请求序列化失败：{e}"))?;
    // Manually percent-encode the JSON so it survives in a URL hash fragment.
    // Only encode characters that are problematic in URLs.
    let encoded: String = json
        .chars()
        .map(|c| match c {
            '"' => "%22".to_string(),
            '{' => "%7B".to_string(),
            '}' => "%7D".to_string(),
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '&' => "%26".to_string(),
            '+' => "%2B".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            _ => c.to_string(),
        })
        .collect();
    let url = format!("index.html#/ssh-terminal?data={encoded}");

    let title = format!(
        "SSH - {}",
        request
            .task_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&request.host)
    );

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
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
        .map_err(|e| format!("SSH 窗口创建失败：{e}"))?;

    Ok(())
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntryValue>, String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpList {
        path,
        response,
    })
    .await
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpUpload {
        local_path,
        remote_path,
        response,
    })
    .await
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpDownload {
        remote_path,
        local_path,
        response,
    })
    .await
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpDelete {
        path,
        response,
    })
    .await
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpRename {
        old_path,
        new_path,
        response,
    })
    .await
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| SshCommand::SftpMkdir {
        path,
        response,
    })
    .await
}

#[tauri::command]
async fn ssh_start_port_forward(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    rule: PortForwardRuleValue,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| {
        SshCommand::StartPortForward { rule, response }
    })
    .await
}

#[tauri::command]
async fn ssh_stop_port_forward(
    state: State<'_, Arc<SshSessionState>>,
    session_id: String,
    rule_id: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &session_id, |response| {
        SshCommand::StopPortForward { rule_id, response }
    })
    .await
}

#[tauri::command]
fn list_known_hosts(app: AppHandle) -> Result<Vec<KnownHostEntry>, String> {
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
fn remove_known_host(app: AppHandle, host_port: String) -> Result<(), String> {
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    let mut known_hosts = load_string_map(&path)?;
    known_hosts.remove(&host_port);
    write_string_map(&path, &known_hosts)
}

#[tauri::command]
fn clear_known_hosts(app: AppHandle) -> Result<(), String> {
    let path = app_data_file(&app, "known-ssh-hosts.json")?;
    write_string_map(&path, &HashMap::new())
}

const MAX_SSH_HISTORY_ENTRIES: usize = 20;

fn load_ssh_history(path: &Path) -> Result<Vec<SshHistoryEntryValue>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取 SSH 历史：{error}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| format!("SSH 历史格式无法识别：{error}"))
}

fn write_ssh_history(path: &Path, entries: &[SshHistoryEntryValue]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(entries).map_err(|error| format!("SSH 历史序列化失败：{error}"))?;
    fs::write(path, text).map_err(|error| format!("无法写入 SSH 历史：{error}"))
}

#[tauri::command]
fn list_ssh_history(app: AppHandle) -> Result<Vec<SshHistoryEntryValue>, String> {
    let path = app_data_file(&app, "ssh-history.json")?;
    load_ssh_history(&path)
}

#[tauri::command]
fn add_ssh_history(
    app: AppHandle,
    host: String,
    port: String,
    username: String,
    task_name: String,
) -> Result<(), String> {
    let path = app_data_file(&app, "ssh-history.json")?;
    let mut entries = load_ssh_history(&path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    entries.retain(|e| !(e.host == host && e.port == port && e.username == username));
    entries.insert(0, SshHistoryEntryValue {
        id: format!("hist-{now}"),
        host,
        port,
        username,
        task_name,
        connected_at: now,
    });
    entries.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
    entries.truncate(MAX_SSH_HISTORY_ENTRIES);
    write_ssh_history(&path, &entries)
}

#[tauri::command]
fn clear_ssh_history(app: AppHandle) -> Result<(), String> {
    let path = app_data_file(&app, "ssh-history.json")?;
    write_ssh_history(&path, &[])
}

#[cfg(desktop)]
#[tauri::command]
fn open_system_ssh_terminal(request: SshConnectionRequest) -> Result<(), String> {
    spawn_ssh_terminal(&request)
}

#[cfg(desktop)]
#[tauri::command]
async fn open_vscode_ssh(app: AppHandle, request: SshConnectionRequest) -> Result<(), String> {
    let alias = prepare_vscode_ssh(&app, &request).await?;
    spawn_vscode_ssh(&alias)
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|error| format!("无法打开外部链接：{error}"))
}

#[cfg(mobile)]
#[tauri::command]
fn install_apk(app: AppHandle, path: String) -> Result<(), String> {
    use std::path::Path;

    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("APK 文件不存在：{path}"));
    }

    // Use tauri-plugin-opener to open the APK file with the system package
    // installer. On Android, open_path fires an ACTION_VIEW intent. The MIME
    // type hint helps the system resolve to the package installer activity.
    app.opener()
        .open_path(path, Some("application/vnd.android.package-archive"))
        .map_err(|error| format!("无法触发 APK 安装：{error}"))
}

#[cfg(desktop)]
#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let path = validate_local_path(&path)?;
    open_path_with_system(&path)
}

#[cfg(desktop)]
#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    let path = validate_local_path(&path)?;
    reveal_path_with_system(&path)
}

#[cfg(desktop)]
#[tauri::command]
fn set_desktop_close_to_tray(
    state: State<'_, Arc<DesktopRuntimeState>>,
    enabled: bool,
) -> Result<(), String> {
    set_close_to_tray_state(&state, enabled)
}

#[cfg(desktop)]
#[tauri::command]
fn set_desktop_close_prompt(
    state: State<'_, Arc<DesktopRuntimeState>>,
    enabled: bool,
) -> Result<(), String> {
    set_close_prompt_state(&state, enabled)
}

#[cfg(desktop)]
#[tauri::command]
fn cancel_desktop_close_prompt() {}

#[cfg(desktop)]
#[tauri::command]
fn complete_desktop_close_prompt(
    app: AppHandle,
    state: State<'_, Arc<DesktopRuntimeState>>,
    action: String,
) -> Result<(), String> {
    match action.as_str() {
        "tray" => {
            hide_main_window(&app);
            Ok(())
        }
        "exit" => {
            set_quit_requested(&state, true);
            app.exit(0);
            Ok(())
        }
        _ => Err("未知关闭操作".to_string()),
    }
}

#[cfg(desktop)]
#[tauri::command]
fn show_desktop_main_window(app: AppHandle) {
    hide_tray_menu(&app);
    show_main_window(&app);
}

#[cfg(desktop)]
#[tauri::command]
fn hide_desktop_tray_menu(app: AppHandle) {
    hide_tray_menu(&app);
}

#[cfg(desktop)]
#[tauri::command]
fn run_due_scheduled_tasks(app: AppHandle) {
    hide_tray_menu(&app);
    let _ = app.emit(DESKTOP_RUN_DUE_EVENT, ());
}

#[cfg(desktop)]
#[tauri::command]
fn quit_desktop_app(app: AppHandle, state: State<'_, Arc<DesktopRuntimeState>>) {
    set_quit_requested(&state, true);
    app.exit(0);
}

/// Exposes the native runtime kind to the renderer so it can pick capability
/// flags without relying on `isTauri()` alone (which is true on mobile too).
#[tauri::command]
fn runtime_platform() -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else {
        "desktop"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NOTE: Do NOT initialize android_logger here — it conflicts with
    // tauri_plugin_log (both try to set the global logger, causing a panic).
    // tauri_plugin_log handles log output on all platforms.

    #[cfg(desktop)]
    let desktop_state = Arc::new(DesktopRuntimeState::default());

    log::info!("creating Tauri builder");
    let mut builder = tauri::Builder::default()
        .manage(Arc::new(SshSessionState::default()));

    #[cfg(desktop)]
    {
        builder = builder
            .manage(Arc::clone(&desktop_state))
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_deep_link::init())
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcut("Alt+Shift+E")
                    .unwrap_or_else(|error| {
                        log::warn!("failed to register default global shortcut: {error}");
                        tauri_plugin_global_shortcut::Builder::new()
                    })
                    .with_handler(|app, _shortcut, event| {
                        if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .build(),
            );
    }

    builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

    // Register tauri_plugin_log in the plugin chain (not inside setup)
    // to ensure it initializes before the setup closure runs.
    if cfg!(debug_assertions) {
        builder = builder.plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );
    }

    log::info!("all plugins registered, setting up");

    builder = builder.setup({
        #[cfg(desktop)]
        let desktop_state = Arc::clone(&desktop_state);
        move |app| {
            log::info!("setup closure entered");

            #[cfg(desktop)]
            if let Some(icon) = app.default_window_icon().cloned() {
                for window in app.webview_windows().values() {
                    window.set_icon(icon.clone())?;
                }
            }

            #[cfg(desktop)]
            {
                let (close_to_tray, close_prompt) = read_close_settings(app.handle()).unwrap_or((false, true));
                if let Err(error) = set_close_to_tray_state(&desktop_state, close_to_tray) {
                    log::warn!("failed to initialize close-to-tray state: {error}");
                }
                if let Err(error) = set_close_prompt_state(&desktop_state, close_prompt) {
                    log::warn!("failed to initialize close prompt state: {error}");
                }
                setup_tray(app)?;
                start_desktop_run_due_timer(app.handle().clone());
            }

            // On mobile, the generated config has an empty windows array,
            // so we must create the webview window explicitly.
            #[cfg(mobile)]
            {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("EasyConsole")
                .build()?;
            }

            log::info!("setup closure completed");
            Ok(())
        }
    });

    log::info!("building Tauri app");

    builder = builder.invoke_handler(tauri::generate_handler![
        open_external_url,
        runtime_storage_get,
        runtime_storage_set,
        runtime_storage_remove,
        #[cfg(desktop)]
        keychain_get,
        #[cfg(desktop)]
        keychain_set,
        #[cfg(desktop)]
        keychain_remove,
        runtime_platform,
        open_ssh_session,
        ssh_write,
        ssh_resize,
        ssh_close,
        sftp_list,
        sftp_upload,
        sftp_download,
        sftp_delete,
        sftp_rename,
        sftp_mkdir,
        ssh_start_port_forward,
        ssh_stop_port_forward,
        #[cfg(desktop)]
        open_ssh_window,
        list_known_hosts,
        remove_known_host,
        clear_known_hosts,
        list_ssh_history,
        add_ssh_history,
        clear_ssh_history,
        #[cfg(mobile)]
        install_apk,
        #[cfg(desktop)]
        open_system_ssh_terminal,
        #[cfg(desktop)]
        open_vscode_ssh,
        #[cfg(desktop)]
        open_local_path,
        #[cfg(desktop)]
        reveal_local_path,
        #[cfg(desktop)]
        set_desktop_close_to_tray,
        #[cfg(desktop)]
        set_desktop_close_prompt,
        #[cfg(desktop)]
        cancel_desktop_close_prompt,
        #[cfg(desktop)]
        complete_desktop_close_prompt,
        #[cfg(desktop)]
        show_desktop_main_window,
        #[cfg(desktop)]
        hide_desktop_tray_menu,
        #[cfg(desktop)]
        run_due_scheduled_tasks,
        #[cfg(desktop)]
        quit_desktop_app
    ]);

    log::info!("invoke handler registered, building app");
    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => {
            log::info!("Tauri app built successfully, starting event loop");
            app
        }
        Err(e) => {
            log::error!("FATAL: failed to build Tauri app: {e:?}");
            panic!("error while building tauri application: {e:?}");
        }
    };
    app.run(move |app, event| {
            #[cfg(desktop)]
            {
                handle_desktop_event(app, &event, &desktop_state);
            }
            #[cfg(not(desktop))]
            {
                let _ = (app, event);
            }
        });
}

#[cfg(desktop)]
fn handle_desktop_event(app: &AppHandle, event: &RunEvent, desktop_state: &Arc<DesktopRuntimeState>) {
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && !is_quit_requested(desktop_state) => {
            if get_close_prompt_state(desktop_state) {
                api.prevent_close();
                let _ = app.emit(DESKTOP_CLOSE_REQUESTED_EVENT, ());
            } else if get_close_to_tray_state(desktop_state) {
                api.prevent_close();
                hide_main_window(app);
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == TRAY_MENU_LABEL => {
            api.prevent_close();
            hide_tray_menu(app);
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Focused(false),
            ..
        } if label == TRAY_MENU_LABEL => {
            hide_tray_menu(app);
        }
        RunEvent::ExitRequested { api, .. } if !is_quit_requested(desktop_state) => {
            if get_close_prompt_state(desktop_state) {
                api.prevent_exit();
                let _ = app.emit(DESKTOP_CLOSE_REQUESTED_EVENT, ());
            } else if get_close_to_tray_state(desktop_state) {
                api.prevent_exit();
                hide_main_window(app);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_on_first_use_records_and_rejects_changed_fingerprint() {
        let mut known_hosts = HashMap::new();
        let key = known_host_key("example.com", 22);

        assert!(trust_on_first_use(&mut known_hosts, key.clone(), "SHA256:first".to_string()));
        assert!(trust_on_first_use(&mut known_hosts, key.clone(), "SHA256:first".to_string()));
        assert!(!trust_on_first_use(&mut known_hosts, key, "SHA256:changed".to_string()));
    }
}
