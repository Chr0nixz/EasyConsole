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
/// and quotes group arguments), and on macOS the title is echoed to the
/// terminal as an escape sequence, so a backend-provided task name must never
/// reach either unfiltered.
#[cfg(all(desktop, any(target_os = "windows", target_os = "macos")))]
fn sanitize_terminal_title(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|ch| !matches!(ch, ';' | '"' | '\'' | '`') && !ch.is_control())
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
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Body of the `.command` file Terminal.app runs. It deletes itself first, so
/// nothing is left behind in the temp directory once the window is open.
#[cfg(all(desktop, target_os = "macos"))]
fn macos_command_script(request: &SshConnectionRequest) -> Result<String, String> {
    let args = ssh_args(request)?
        .iter()
        .map(|arg| shell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let title = request
        .task_name
        .as_deref()
        .map(sanitize_terminal_title)
        .unwrap_or_else(|| "EasyConsole SSH".to_string());
    Ok(format!(
        "#!/bin/sh\nrm -f \"$0\"\nprintf '\\033]0;%s\\007' {title}\nexec ssh {args}\n",
        title = shell_single_quote(&title),
    ))
}

/// Opens a new Terminal.app window running `ssh`.
///
/// Terminal runs `.command` files through the user's login shell, so `ssh`
/// resolves with the user's full PATH and config. Unlike scripting Terminal
/// through `osascript`, this needs no Automation permission prompt and keeps
/// working under the hardened runtime of a signed build.
#[cfg(all(desktop, target_os = "macos"))]
fn spawn_ssh_terminal(request: &SshConnectionRequest) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let script = macos_command_script(request)?;
    let path = std::env::temp_dir().join(format!(
        "easyconsole-ssh-{}.command",
        uuid::Uuid::new_v4().simple()
    ));
    let write_error = |error: std::io::Error| {
        trf!(
            "无法创建终端启动脚本：{error}",
            "Failed to create the terminal launch script: {error}"
        )
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .map_err(write_error)?;
    if let Err(error) = file.write_all(script.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(write_error(error));
    }
    drop(file);

    let result = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.Terminal"])
        .arg(&path)
        .output();
    let error = match result {
        Ok(output) if output.status.success() => return Ok(()),
        Ok(output) if output.stderr.is_empty() => output.status.to_string(),
        Ok(output) => String::from_utf8_lossy(&output.stderr).trim().to_string(),
        Err(error) => error.to_string(),
    };
    let _ = std::fs::remove_file(&path);
    Err(trf!(
        "无法打开系统终端：{error}",
        "Failed to open the system terminal: {error}"
    ))
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
pub async fn open_system_ssh_terminal(
    window: tauri::WebviewWindow,
    request: SshConnectionRequest,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    // LaunchServices can take a moment to answer.
    tauri::async_runtime::spawn_blocking(move || spawn_ssh_terminal(&request))
        .await
        .map_err(|error| error.to_string())?
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_command_script_passes_literal_arguments_and_removes_itself() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let mock_ssh = directory.path().join("ssh");
        fs::write(&mock_ssh, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        fs::set_permissions(&mock_ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let script = macos_command_script(&request(
            "10.0.0.8",
            Some("30222"),
            Some("root"),
            Some("gpu'job $(exit 42)\u{1b}]0;x\u{7}"),
        ))
        .unwrap();
        let script_path = directory.path().join("SSH with spaces.command");
        fs::write(&script_path, script).unwrap();
        let output = Command::new("/bin/sh")
            .arg(&script_path)
            .env("PATH", format!("{}:/bin", directory.path().display()))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "\u{1b}]0;gpujob $(exit 42)]0x\u{7}-p\n30222\n--\nroot@10.0.0.8\n"
        );
        assert!(!script_path.exists());

        let untitled = macos_command_script(&request("example.com", None, None, None)).unwrap();
        assert!(untitled.contains("'EasyConsole SSH'"));
        assert!(untitled.ends_with("exec ssh '--' 'example.com'\n"));

        assert!(macos_command_script(&request("-oProxyCommand=calc", None, None, None)).is_err());
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn sanitize_terminal_title_strips_injection_characters() {
        assert_eq!(sanitize_terminal_title("task;calc"), "taskcalc");
        assert_eq!(sanitize_terminal_title("  a\"b`c  "), "abc");
        assert_eq!(sanitize_terminal_title(";;"), "EasyConsole SSH");
        assert_eq!(sanitize_terminal_title("ok").len(), 2);
    }
}
