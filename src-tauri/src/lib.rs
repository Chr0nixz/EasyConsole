use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key;
use russh::{client, ChannelMsg};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

const SSH_SESSION_EVENT: &str = "ssh-session-event";
const DEFAULT_COLS: u32 = 120;
const DEFAULT_ROWS: u32 = 32;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SshConnectionRequest {
    host: String,
    port: Option<String>,
    username: Option<String>,
    password: Option<String>,
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

struct EasyConsoleSshClient;

impl client::Handler for EasyConsoleSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

fn emit_session_event(app: &AppHandle, session_id: &str, kind: &'static str, data: Option<String>, message: Option<String>) {
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
    port.parse::<u16>().map_err(|_| "SSH Port 不是有效数字".to_string())
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

#[cfg(target_os = "windows")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "linux")]
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

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn spawn_ssh_terminal(_request: &SshConnectionRequest) -> Result<(), String> {
    Err("当前平台暂不支持桌面端 SSH 启动".to_string())
}

async fn run_russh_session(
    app: AppHandle,
    session_id: String,
    request: SshConnectionRequest,
    mut rx: mpsc::UnboundedReceiver<SshCommand>,
) -> Result<(), String> {
    let host = validate_host(&request.host)?;
    let port = parse_port(request.port.as_deref())?;
    let username = validate_username(request.username.as_deref())?.ok_or_else(|| "SSH Username 为空，无法建立连接".to_string())?;
    let password = request
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "SSH Password 为空，无法自动登录".to_string())?
        .to_string();
    let cols = request.cols.unwrap_or(DEFAULT_COLS).max(1);
    let rows = request.rows.unwrap_or(DEFAULT_ROWS).max(1);

    emit_session_event(&app, &session_id, "status", None, Some(format!("正在连接 {host}:{port}")));

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..<_>::default()
    });
    let mut session = client::connect(config, (host.as_str(), port), EasyConsoleSshClient)
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

    emit_session_event(&app, &session_id, "status", None, Some("SSH 已连接".to_string()));

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
        if let Err(error) = run_russh_session(app.clone(), task_session_id.clone(), request, rx).await {
            emit_session_event(&app, &task_session_id, "error", None, Some(error));
        }
        remove_session(&task_state, &task_session_id);
        emit_session_event(&app, &task_session_id, "closed", None, Some("SSH 会话已关闭".to_string()));
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

#[tauri::command]
fn ssh_write(state: State<'_, Arc<SshSessionState>>, session_id: String, data: String) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Write(data))
}

#[tauri::command]
fn ssh_resize(state: State<'_, Arc<SshSessionState>>, session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Resize { cols, rows })
}

#[tauri::command]
fn ssh_close(state: State<'_, Arc<SshSessionState>>, session_id: String) -> Result<(), String> {
    send_session_command(state, &session_id, SshCommand::Close)
}

#[tauri::command]
fn open_system_ssh_terminal(request: SshConnectionRequest) -> Result<(), String> {
    spawn_ssh_terminal(&request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(SshSessionState::default()))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_ssh_session,
            ssh_write,
            ssh_resize,
            ssh_close,
            open_system_ssh_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
