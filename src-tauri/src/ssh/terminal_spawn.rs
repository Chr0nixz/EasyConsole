use std::process::Command;

use crate::ssh::session::{validate_host, validate_username, SshConnectionRequest};
use crate::trf;

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
            return Err(trf!(
                "SSH Port 不是有效数字",
                "SSH Port is not a valid number"
            ));
        }
        args.push("-p".to_string());
        args.push(port.to_string());
    }

    let username = validate_username(request.username.as_deref())?;
    let target = username
        .map(|username| format!("{username}@{host}"))
        .unwrap_or(host);
    args.push("--".to_string());
    args.push(target);
    Ok(args)
}

/// Windows Terminal re-parses its own command line (`;` separates wt commands
/// and quotes group arguments), so a backend-provided task name must never
/// reach `wt --title` unfiltered.
#[cfg(all(desktop, target_os = "windows"))]
fn sanitize_terminal_title(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|ch| !matches!(ch, ';' | '"' | '\'' | '`' | '\n' | '\r'))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "EasyConsole SSH".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

#[cfg(all(desktop, target_os = "windows"))]
fn spawn_ssh_terminal(request: &SshConnectionRequest) -> Result<(), String> {
    let args = ssh_args(request)?;
    let title = request
        .task_name
        .as_deref()
        .map(sanitize_terminal_title)
        .unwrap_or_else(|| "EasyConsole SSH".to_string());
    let mut wt_args = vec![
        "new-tab".to_string(),
        "--title".to_string(),
        title,
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
                .map_err(|error| {
                    trf!(
                        "无法打开系统终端：{error}",
                        "Failed to open the system terminal: {error}"
                    )
                })
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
        .map_err(|error| {
            trf!(
                "无法打开系统终端：{error}",
                "Failed to open the system terminal: {error}"
            )
        })
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
    Err(trf!(
        "无法打开系统终端，请确认本机已安装终端和 ssh 客户端",
        "Failed to open the system terminal. Make sure a terminal and an ssh client are installed."
    ))
}

#[tauri::command]
pub fn open_system_ssh_terminal(
    window: tauri::WebviewWindow,
    request: SshConnectionRequest,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    spawn_ssh_terminal(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        host: &str,
        port: Option<&str>,
        username: Option<&str>,
        task_name: Option<&str>,
    ) -> SshConnectionRequest {
        SshConnectionRequest {
            host: host.to_string(),
            port: port.map(str::to_string),
            username: username.map(str::to_string),
            password: None,
            command: None,
            task_id: None,
            task_name: task_name.map(str::to_string),
            cols: None,
            rows: None,
            connect_timeout_sec: None,
            keepalive_interval_sec: None,
            term_type: None,
            ssh_key_path: None,
            auth_mode: None,
        }
    }

    #[test]
    fn ssh_args_builds_target_and_port() {
        let args = ssh_args(&request("10.0.0.8", Some("30222"), Some("root"), None)).unwrap();
        assert_eq!(args, vec!["-p", "30222", "--", "root@10.0.0.8"]);

        let bare = ssh_args(&request("example.com", None, None, None)).unwrap();
        assert_eq!(bare, vec!["--", "example.com"]);

        assert!(ssh_args(&request("bad host", None, None, None)).is_err());
        assert!(ssh_args(&request("example.com", Some("22x"), None, None)).is_err());
        assert!(ssh_args(&request(" -oProxyCommand=calc", None, None, None)).is_err());
        assert!(ssh_args(&request("-v", None, None, None)).is_err());
        assert!(ssh_args(&request("example.com", None, Some("-root"), None)).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sanitize_terminal_title_strips_injection_characters() {
        assert_eq!(sanitize_terminal_title("task;calc"), "taskcalc");
        assert_eq!(sanitize_terminal_title("  a\"b`c  "), "abc");
        assert_eq!(sanitize_terminal_title(";;"), "EasyConsole SSH");
        assert_eq!(sanitize_terminal_title("ok").len(), 2);
    }
}
