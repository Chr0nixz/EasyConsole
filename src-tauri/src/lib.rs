use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectionRequest {
    host: String,
    port: Option<String>,
    username: Option<String>,
    task_name: Option<String>,
}

fn ssh_args(request: &SshConnectionRequest) -> Result<Vec<String>, String> {
    let host = request.host.trim();
    if host.is_empty() {
        return Err("SSH Host 为空，无法打开连接".to_string());
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'))
    {
        return Err("SSH Host 包含不支持的字符".to_string());
    }

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

    let username = request
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(username) = username {
        if !username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        {
            return Err("SSH Username 包含不支持的字符".to_string());
        }
    }

    let target = username
        .map(|username| format!("{username}@{host}"))
        .unwrap_or_else(|| host.to_string());
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

#[tauri::command]
fn open_ssh_session(request: SshConnectionRequest) -> Result<(), String> {
    spawn_ssh_terminal(&request)
}

#[tauri::command]
fn open_system_ssh_terminal(request: SshConnectionRequest) -> Result<(), String> {
    spawn_ssh_terminal(&request)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            open_system_ssh_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
