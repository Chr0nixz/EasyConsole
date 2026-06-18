use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use std::process::Command;
use russh::keys::ssh_key::{self, HashAlg};
use russh::{client, ChannelMsg};
use tokio::sync::mpsc;
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

#[derive(Debug, Deserialize, Clone)]
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
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshSessionEvent {
    session_id: String,
    kind: &'static str,
    data: Option<String>,
    message: Option<String>,
}

enum SshCommand {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
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
    let mut session = client::connect(config, (host.as_str(), port), handler)
        .await
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
        .ok_or_else(|| "SSH Password 为空，无法自动登录".to_string())?
        .to_string();
    let cols = request.cols.unwrap_or(DEFAULT_COLS).max(1);
    let rows = request.rows.unwrap_or(DEFAULT_ROWS).max(1);

    emit_session_event(
        &app,
        &session_id,
        "status",
            None,
            Some(format!("正在连接 {host}:{port}")),
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 0,
        ..<_>::default()
    });
    let handler = EasyConsoleSshClient {
        app: app.clone(),
        host: host.clone(),
        port,
    };
    let mut session = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|error| format!("SSH 连接失败：{error}"))?;

    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(|error| format!("SSH 认证失败：{error}"))?;
    if !auth.success() {
        return Err("SSH 认证失败：用户名或密码不正确".to_string());
    }

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话打开失败：{error}"))?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
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
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                        break;
                    }
                }
            }
            message = channel.wait() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        emit_session_event(
                            &app,
                            &session_id,
                            "output",
                            Some(String::from_utf8_lossy(&data).to_string()),
                            None,
                        );
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        emit_session_event(&app, &session_id, "status", None, Some(format!("SSH 进程已退出，状态码 {exit_status}")));
                    }
                    ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                        emit_session_event(
                            &app,
                            &session_id,
                            "status",
                            None,
                            Some(format!("SSH 进程收到信号 {signal_name:?}: {error_message}")),
                        );
                    }
                    ChannelMsg::Close | ChannelMsg::Eof => {
                        break;
                    }
                    _ => {}
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

fn runtime_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_data_file(app, "runtime-storage.json")
}

#[tauri::command]
fn runtime_storage_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = runtime_storage_path(&app)?;
    let data = load_string_map(&path)?;
    Ok(data.get(&key).cloned())
}

#[tauri::command]
fn runtime_storage_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = runtime_storage_path(&app)?;
    let mut data = load_string_map(&path)?;
    data.insert(key, value);
    write_string_map(&path, &data)
}

#[tauri::command]
fn runtime_storage_remove(app: AppHandle, key: String) -> Result<(), String> {
    let path = runtime_storage_path(&app)?;
    let mut data = load_string_map(&path)?;
    data.remove(&key);
    write_string_map(&path, &data)
}

#[cfg(desktop)]
fn read_close_to_tray_setting(app: &AppHandle) -> bool {
    let Ok(path) = runtime_storage_path(app) else {
        return false;
    };
    let Ok(data) = load_string_map(&path) else {
        return false;
    };
    let Some(raw) = data.get(APP_SETTINGS_STORAGE_KEY) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("desktopCloseToTray").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

#[cfg(desktop)]
fn read_close_prompt_setting(app: &AppHandle) -> bool {
    let Ok(path) = runtime_storage_path(app) else {
        return true;
    };
    let Ok(data) = load_string_map(&path) else {
        return true;
    };
    let Some(raw) = data.get(APP_SETTINGS_STORAGE_KEY) else {
        return true;
    };
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("desktopClosePrompt").and_then(serde_json::Value::as_bool))
        .unwrap_or(true)
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
    ensure_tray_menu_window(app.handle())?;
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
    #[cfg(target_os = "android")]
    {
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Trace)
                .with_tag("EasyConsole"),
        );
        log::info!("=== EasyConsole Android run() started ===");
    }

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
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

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
                let close_to_tray = read_close_to_tray_setting(app.handle());
                if let Err(error) = set_close_to_tray_state(&desktop_state, close_to_tray) {
                    log::warn!("failed to initialize close-to-tray state: {error}");
                }
                let close_prompt = read_close_prompt_setting(app.handle());
                if let Err(error) = set_close_prompt_state(&desktop_state, close_prompt) {
                    log::warn!("failed to initialize close prompt state: {error}");
                }
                setup_tray(app)?;
                start_desktop_run_due_timer(app.handle().clone());
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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
        runtime_platform,
        open_ssh_session,
        ssh_write,
        ssh_resize,
        ssh_close,
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
