use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::HashAlg;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::app_data_file;
use crate::ssh::host_key::EasyConsoleSshClient;
use crate::ssh::session::{
    expand_key_path, parse_port, require_username, validate_host, SshConnectionRequest,
};
use crate::trf;

/// Comment marker stamped onto generated keys and recorded in the remote
/// `authorized_keys` line. Revocation matches this exact marker, so only
/// EasyConsole-managed lines are ever removed.
#[cfg(desktop)]
const VSCODE_KEY_MARKER: &str = "easyconsole-vscode";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VscodeKeyRecord {
    alias: String,
    host: String,
    port: String,
    username: String,
    fingerprint: String,
    installed_at: i64,
}

/// Serializes read-modify-write on `vscode-keys.json`.
#[cfg(desktop)]
static VSCODE_KEYS_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();

#[cfg(desktop)]
fn vscode_keys_lock() -> &'static Mutex<()> {
    VSCODE_KEYS_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(desktop)]
fn load_vscode_key_records(path: &Path) -> Vec<VscodeKeyRecord> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str(&text).unwrap_or_default()
}

#[cfg(desktop)]
fn write_vscode_key_records(path: &Path, records: &[VscodeKeyRecord]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(records).map_err(|error| {
        trf!(
            "VS Code key 记录序列化失败：{error}",
            "Failed to serialize the VS Code key records: {error}"
        )
    })?;
    let parent = path.parent().ok_or_else(|| {
        trf!(
            "无法定位 VS Code key 记录目录",
            "Failed to locate the VS Code key record directory"
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        trf!(
            "无法创建 VS Code key 记录目录：{error}",
            "Failed to create the VS Code key record directory: {error}"
        )
    })?;
    let tmp = parent.join("vscode-keys.json.tmp");
    fs::write(&tmp, text).map_err(|error| {
        trf!(
            "无法写入 VS Code key 记录：{error}",
            "Failed to write the VS Code key records: {error}"
        )
    })?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        trf!(
            "无法提交 VS Code key 记录写入：{error}",
            "Failed to commit the VS Code key records: {error}"
        )
    })
}

#[cfg(desktop)]
fn record_vscode_key(app: &AppHandle, record: VscodeKeyRecord) -> Result<(), String> {
    let path = app_data_file(app, "vscode-keys.json")?;
    let _guard = vscode_keys_lock().lock().map_err(|e| {
        trf!(
            "VS Code key 记录锁获取失败：{e}",
            "Failed to acquire the VS Code key record lock: {e}"
        )
    })?;
    let mut records = load_vscode_key_records(&path);
    records.retain(|entry| entry.alias != record.alias);
    records.insert(0, record);
    write_vscode_key_records(&path, &records)
}

#[cfg(desktop)]
fn remove_vscode_key_record(app: &AppHandle, alias: &str) -> Result<(), String> {
    let path = app_data_file(app, "vscode-keys.json")?;
    let _guard = vscode_keys_lock().lock().map_err(|e| {
        trf!(
            "VS Code key 记录锁获取失败：{e}",
            "Failed to acquire the VS Code key record lock: {e}"
        )
    })?;
    let mut records = load_vscode_key_records(&path);
    records.retain(|entry| entry.alias != alias);
    write_vscode_key_records(&path, &records)
}

#[cfg(desktop)]
fn require_password(password: Option<&str>) -> Result<String, String> {
    password
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            trf!(
                "SSH Password 为空，无法为 VS Code 配置免密登录",
                "SSH Password is empty; cannot configure passwordless login for VS Code"
            )
        })
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

/// Derives the SSH config alias and the sanitized suffix used for the
/// per-host key file name and the `authorized_keys` comment marker.
#[cfg(desktop)]
fn vscode_ssh_alias_parts(request: &SshConnectionRequest) -> Result<(String, String), String> {
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
        return Err(trf!(
            "无法生成 VS Code SSH Host 别名",
            "Failed to generate the VS Code SSH host alias"
        ));
    }
    Ok((format!("easyconsole-{suffix}"), suffix))
}

#[cfg(desktop)]
fn user_ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            trf!(
                "无法定位当前用户主目录，不能写入 SSH 配置",
                "Failed to locate the current user's home directory; cannot write the SSH config"
            )
        })?;
    Ok(home.join(".ssh"))
}

/// Ensures a dedicated ed25519 key exists for this target. Keys are generated
/// per host suffix (instead of one shared key) and carry a comment marker so
/// the remote `authorized_keys` line can be identified and revoked later.
#[cfg(desktop)]
fn ensure_vscode_key(app: &AppHandle, suffix: &str) -> Result<(PathBuf, String), String> {
    let key_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            trf!(
                "无法定位应用数据目录：{error}",
                "Failed to locate the app data directory: {error}"
            )
        })?
        .join("ssh");
    fs::create_dir_all(&key_dir).map_err(|error| {
        trf!(
            "无法创建 SSH key 目录：{error}",
            "Failed to create the SSH key directory: {error}"
        )
    })?;

    let private_key = key_dir.join(format!("easyconsole_vscode_{suffix}"));
    let public_key = key_dir.join(format!("easyconsole_vscode_{suffix}.pub"));
    let comment = format!("{VSCODE_KEY_MARKER}:{suffix}");
    if !private_key.exists() {
        if public_key.exists() {
            let _ = fs::remove_file(&public_key);
        }
        let status = Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-C", &comment, "-f"])
            .arg(&private_key)
            .status()
            .map_err(|error| {
                trf!(
                    "无法运行 ssh-keygen：{error}",
                    "Failed to run ssh-keygen: {error}"
                )
            })?;
        if !status.success() {
            return Err(trf!(
                "ssh-keygen 生成 VS Code 专用 SSH key 失败",
                "ssh-keygen failed to generate the dedicated VS Code SSH key"
            ));
        }
    } else if !public_key.exists() {
        let output = Command::new("ssh-keygen")
            .args(["-y", "-f"])
            .arg(&private_key)
            .output()
            .map_err(|error| {
                trf!(
                    "无法从私钥恢复 SSH 公钥：{error}",
                    "Failed to recover the SSH public key from the private key: {error}"
                )
            })?;
        if !output.status.success() {
            return Err(trf!(
                "ssh-keygen 恢复 VS Code 专用 SSH 公钥失败",
                "ssh-keygen failed to recover the dedicated VS Code SSH public key"
            ));
        }
        // ssh-keygen -y prints only "type data"; re-attach the marker comment.
        let recovered = format!(
            "{} {}\n",
            String::from_utf8_lossy(&output.stdout).trim(),
            comment
        );
        fs::write(&public_key, recovered).map_err(|error| {
            trf!(
                "无法写入 SSH 公钥：{error}",
                "Failed to write the SSH public key: {error}"
            )
        })?;
    }

    let public_key_text = fs::read_to_string(&public_key).map_err(|error| {
        trf!(
            "无法读取 SSH 公钥：{error}",
            "Failed to read the SSH public key: {error}"
        )
    })?;
    let public_key_text = public_key_text.trim().to_string();
    if public_key_text.is_empty() {
        return Err(trf!(
            "SSH 公钥为空，无法配置免密登录",
            "The SSH public key is empty; cannot configure passwordless login"
        ));
    }

    Ok((private_key, public_key_text))
}

/// SHA-256 fingerprint of an OpenSSH-format public key line.
#[cfg(desktop)]
fn public_key_fingerprint(public_key_text: &str) -> Result<String, String> {
    let key = russh::keys::PublicKey::from_openssh(public_key_text).map_err(|error| {
        trf!(
            "无法解析 SSH 公钥：{error}",
            "Failed to parse the SSH public key: {error}"
        )
    })?;
    Ok(format!("{}", key.fingerprint(HashAlg::Sha256)))
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
fn vscode_ssh_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| {
            trf!(
                "无法定位应用数据目录：{error}",
                "Failed to locate the app data directory: {error}"
            )
        })?
        .join("ssh"))
}

/// The shared key written by installs that predate per-host keys. It carries
/// no record in `vscode-keys.json`, so cleanup is a separate one-time flow.
#[cfg(desktop)]
fn legacy_vscode_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(vscode_ssh_app_dir(app)?.join("easyconsole_vscode_ed25519"))
}

/// Drops every EasyConsole-marked config block whose IdentityFile references
/// `identity_file`, keeping all other lines. Returns `None` when a start
/// marker is found without its end marker — the same abort-instead-of-corrupt
/// rule as [`strip_easy_console_block`].
#[cfg(desktop)]
fn strip_config_blocks_referencing(current: &str, identity_file: &Path) -> Option<String> {
    let identity = identity_file.to_string_lossy().replace('\\', "/");
    let mut next = String::new();
    // Some((lines, references_the_identity_file)) while inside a block.
    let mut block: Option<(Vec<String>, bool)> = None;

    for line in current.lines() {
        let trimmed = line.trim();
        match &mut block {
            None => {
                if trimmed.starts_with("# >>> EasyConsole ") {
                    block = Some((vec![line.to_string()], false));
                } else {
                    next.push_str(line);
                    next.push('\n');
                }
            }
            Some((lines, referenced)) => {
                lines.push(line.to_string());
                if let Some(value) = trimmed.strip_prefix("IdentityFile") {
                    let normalized = value.trim().replace('\\', "/");
                    if normalized.trim_matches('"') == identity {
                        *referenced = true;
                    }
                }
                if trimmed.starts_with("# <<< EasyConsole ") {
                    let (lines, referenced) = block.take().unwrap();
                    if !referenced {
                        for kept in lines {
                            next.push_str(&kept);
                            next.push('\n');
                        }
                    }
                }
            }
        }
    }

    if block.is_some() {
        return None;
    }
    Some(next)
}

/// Remove a previously written EasyConsole block, keeping every other line.
///
/// Returns `None` when a start marker is found without its matching end marker.
/// In that case the remainder of the file has already been swallowed by the
/// skip state, so the caller must abort rather than persist the result.
#[cfg(desktop)]
fn strip_easy_console_block(current: &str, start_marker: &str, end_marker: &str) -> Option<String> {
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

    if skipping {
        return None;
    }
    Some(next)
}

/// Replace the user's SSH config atomically, keeping a recoverable copy.
///
/// A plain `fs::write` here is dangerous: a partial write leaves a truncated
/// config, which in turn produces an unpaired EasyConsole marker, which the
/// block parser would then treat as "skip everything after it". That failure
/// mode compounds, so the write must be all-or-nothing.
#[cfg(desktop)]
fn write_user_ssh_config(config_path: &Path, contents: &str) -> Result<(), String> {
    let parent = config_path.parent().ok_or_else(|| {
        trf!(
            "无法定位本机 SSH 配置目录",
            "Failed to locate the local SSH config directory"
        )
    })?;
    let file_name = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let tmp_path = parent.join(format!("{file_name}.easy-console.tmp"));

    // Copy (not rename) so the original stays intact until the final rename.
    if config_path.exists() {
        let bak_path = parent.join(format!("{file_name}.easy-console.bak"));
        fs::copy(config_path, &bak_path).map_err(|error| {
            trf!(
                "无法备份本机 SSH 配置：{error}",
                "Failed to back up the local SSH config: {error}"
            )
        })?;
    }

    fs::write(&tmp_path, contents).map_err(|error| {
        trf!(
            "无法写入本机 SSH 配置临时文件：{error}",
            "Failed to write the local SSH config temp file: {error}"
        )
    })?;

    // Preserve the existing mode so we never loosen a config the user tightened.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(config_path)
            .ok()
            .map(|meta| meta.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(mode));
    }

    fs::rename(&tmp_path, config_path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        trf!(
            "无法提交本机 SSH 配置写入：{error}",
            "Failed to commit the local SSH config write: {error}"
        )
    })
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
    fs::create_dir_all(&ssh_dir).map_err(|error| {
        trf!(
            "无法创建本机 SSH 配置目录：{error}",
            "Failed to create the local SSH config directory: {error}"
        )
    })?;
    let config_path = ssh_dir.join("config");
    let current = fs::read_to_string(&config_path).unwrap_or_default();
    let start_marker = format!("# >>> EasyConsole {alias}");
    let end_marker = format!("# <<< EasyConsole {alias}");

    let mut next = strip_easy_console_block(&current, &start_marker, &end_marker).ok_or_else(|| {
        trf!(
            "本机 SSH 配置中的 EasyConsole 标记不完整：找到「{start_marker}」但缺少对应的「{end_marker}」。\
             为避免误删配置，本次未做任何修改。请手动修复 {} 后重试。",
            "Incomplete EasyConsole markers in the local SSH config: found \"{start_marker}\" but the matching \"{end_marker}\" is missing. To avoid deleting config by mistake, nothing was changed. Fix {} manually and retry.",
            config_path.display()
        )
    })?;

    if !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&format!(
        "{start_marker}\nHost {alias}\n  HostName {host}\n  User {username}\n  Port {port}\n  IdentityFile {}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n{end_marker}\n",
        ssh_config_identity_path(identity_file),
    ));

    write_user_ssh_config(&config_path, &next)
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
        .map_err(|error| {
            trf!(
                "无法打开浏览器：{error}",
                "Failed to open the browser: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "macos"))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开浏览器：{error}",
                "Failed to open the browser: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "linux"))]
fn open_url_in_browser(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开浏览器：{error}",
                "Failed to open the browser: {error}"
            )
        })
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
    open_url_in_browser(&uri).map_err(|error| {
        trf!(
            "无法打开 VS Code：{error}",
            "Failed to open VS Code: {error}"
        )
    })
}

/// Connects to the target for a one-shot VS Code setup operation. Host keys
/// are never prompted for or implicitly accepted: an unknown or changed
/// fingerprint fails the operation.
#[cfg(desktop)]
async fn connect_for_vscode_setup(
    app: &AppHandle,
    request: &SshConnectionRequest,
    operation_label: &str,
) -> Result<client::Handle<EasyConsoleSshClient>, String> {
    let host = validate_host(&request.host)?;
    let port = parse_port(request.port.as_deref())?;
    require_username(request.username.as_deref())?;

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 0,
        ..<_>::default()
    });
    let host_key_error = Arc::new(Mutex::new(None));
    let handler = EasyConsoleSshClient {
        app: app.clone(),
        session_id: "vscode-setup".to_string(),
        host: host.clone(),
        port,
        host_key_error: Arc::clone(&host_key_error),
        allow_host_key_prompt: false,
        window_label: String::new(),
    };
    let session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| {
        trf!(
            "SSH 连接超时，无法{operation_label}，请检查网络和主机是否可达",
            "SSH connection timed out; cannot {operation_label}. Check the network and whether the host is reachable."
        )
    })?
    .map_err(|error| {
        if let Ok(guard) = host_key_error.lock() {
            if let Some(message) = guard.as_ref() {
                return message.clone();
            }
        }
        trf!(
            "SSH 连接失败，无法{operation_label}：{error}",
            "SSH connection failed; cannot {operation_label}: {error}"
        )
    })?;
    Ok(session)
}

/// Runs a shell command on the target and reports failure with captured output.
#[cfg(desktop)]
async fn exec_remote_command(
    session: client::Handle<EasyConsoleSshClient>,
    command: &str,
    failure_label: &str,
) -> Result<(), String> {
    let mut channel = session.channel_open_session().await.map_err(|error| {
        trf!(
            "SSH 会话打开失败，无法{failure_label}：{error}",
            "Failed to open the SSH session; cannot {failure_label}: {error}"
        )
    })?;
    channel.exec(true, command).await.map_err(|error| {
        trf!(
            "远端命令执行失败，无法{failure_label}：{error}",
            "The remote command failed; cannot {failure_label}: {error}"
        )
    })?;

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
            return Err(trf!("{failure_label}失败", "{failure_label} failed"));
        }
        return Err(trf!(
            "{failure_label}失败：{output}",
            "{failure_label} failed: {output}"
        ));
    }

    Ok(())
}

#[cfg(desktop)]
async fn install_vscode_public_key(
    app: &AppHandle,
    request: &SshConnectionRequest,
    public_key: &str,
) -> Result<(), String> {
    let label = trf!(
        "配置 VS Code 免密登录",
        "configure passwordless VS Code access"
    );
    let password = require_password(request.password.as_deref())?;
    let quoted_key = shell_single_quote(public_key);
    let command = format!(
        "umask 077; mkdir -p \"$HOME/.ssh\" && touch \"$HOME/.ssh/authorized_keys\" && (grep -qxF {quoted_key} \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' {quoted_key} >> \"$HOME/.ssh/authorized_keys\") && chmod 700 \"$HOME/.ssh\" && chmod 600 \"$HOME/.ssh/authorized_keys\"",
    );

    let mut session = connect_for_vscode_setup(app, request, &label).await?;
    let username = require_username(request.username.as_deref())?;
    let auth = session
        .authenticate_password(username, password)
        .await
        .map_err(|error| {
            trf!(
                "SSH 认证失败，无法{label}：{error}",
                "SSH authentication failed; cannot {label}: {error}"
            )
        })?;
    if !auth.success() {
        return Err(trf!(
            "SSH 认证失败，无法{label}：用户名或密码不正确",
            "SSH authentication failed; cannot {label}: incorrect username or password"
        ));
    }

    exec_remote_command(session, &command, &label).await
}

/// Removes every `authorized_keys` line carrying this install's marker from
/// the remote host, authenticating with the per-host key first and falling
/// back to the password when one was supplied.
#[cfg(desktop)]
async fn revoke_vscode_remote_key(
    app: &AppHandle,
    request: &SshConnectionRequest,
    key_path: &Path,
) -> Result<(), String> {
    let label = trf!(
        "撤销 VS Code 免密登录",
        "revoke passwordless VS Code access"
    );
    let username = require_username(request.username.as_deref())?;
    // `awk` filters by the comment (last) field: the per-host lines end with
    // `easyconsole-vscode:<suffix>` and the legacy shared line ends with the
    // bare marker, so one pass removes both without touching other keys.
    // awk exits 0 even when nothing prints, and rewriting through a temp file
    // keeps the change atomic enough for a one-line shell.
    let command = format!(
        "umask 077; f=\"$HOME/.ssh/authorized_keys\"; if [ -f \"$f\" ]; then t=$(mktemp); awk '{{ if ($NF != \"{VSCODE_KEY_MARKER}\" && $NF !~ /^{VSCODE_KEY_MARKER}:/) print }}' \"$f\" > \"$t\" || true; cat \"$t\" > \"$f\"; rm -f \"$t\"; chmod 600 \"$f\"; fi",
    );

    let mut session = connect_for_vscode_setup(app, request, &label).await?;
    let mut authed = false;
    // The per-host key is the normal path: it authenticated this host before.
    if let Ok(key_pair) =
        russh::keys::load_secret_key(expand_key_path(&key_path.to_string_lossy()), None)
    {
        let key_with_hash =
            russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha256));
        if let Ok(auth) = session
            .authenticate_publickey(username.clone(), key_with_hash)
            .await
        {
            authed = auth.success();
        }
    }
    if !authed {
        // No usable key: a password from the request (task panel path) can
        // still complete the revocation.
        let password = require_password(request.password.as_deref()).map_err(|_| {
            trf!(
                "本机 VS Code 专用 key 已无法登录该主机，且未提供密码；请在任务面板中使用带密码的撤销操作",
                "The local VS Code key can no longer sign in to this host and no password was provided; use the password-backed revoke from the task panel"
            )
        })?;
        let auth = session
            .authenticate_password(username, password)
            .await
            .map_err(|error| {
                trf!(
                    "SSH 认证失败，无法{label}：{error}",
                    "SSH authentication failed; cannot {label}: {error}"
                )
            })?;
        if !auth.success() {
            return Err(trf!(
                "SSH 认证失败，无法{label}：用户名或密码不正确",
                "SSH authentication failed; cannot {label}: incorrect username or password"
            ));
        }
    }

    exec_remote_command(session, &command, &label).await
}

#[cfg(desktop)]
async fn prepare_vscode_ssh(
    app: &AppHandle,
    request: &SshConnectionRequest,
) -> Result<String, String> {
    let (alias, suffix) = vscode_ssh_alias_parts(request)?;
    let (identity_file, public_key) = ensure_vscode_key(app, &suffix)?;
    install_vscode_public_key(app, request, &public_key).await?;
    write_vscode_ssh_config(request, &alias, &identity_file)?;
    // Record what was installed so it can be listed and revoked later.
    record_vscode_key(
        app,
        VscodeKeyRecord {
            fingerprint: public_key_fingerprint(&public_key)?,
            installed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            alias: alias.clone(),
            host: request.host.trim().to_string(),
            port: request.port.clone().unwrap_or_default(),
            username: request.username.clone().unwrap_or_default(),
        },
    )?;
    Ok(alias)
}

/// Removes a VS Code Remote-SSH setup: the marked `authorized_keys` line on
/// the host (when `remove_remote`), the local SSH config block, and the local
/// key + record. Local cleanup only happens after the remote step succeeded,
/// so a failed revocation never leaves the user with neither working access
/// nor a record.
#[cfg(desktop)]
async fn revoke_vscode_setup(
    app: &AppHandle,
    request: &SshConnectionRequest,
    remove_remote: bool,
) -> Result<(), String> {
    let (alias, suffix) = vscode_ssh_alias_parts(request)?;
    let key_path = vscode_ssh_app_dir(app)?.join(format!("easyconsole_vscode_{suffix}"));

    if remove_remote {
        revoke_vscode_remote_key(app, request, &key_path).await?;
    }

    // Remote access is gone (or was left in place by request); now clean up
    // the local side. The config block is removed even if the block markers
    // are missing — a revoke must not be blocked by a hand-edited config.
    let ssh_dir = user_ssh_dir()?;
    let config_path = ssh_dir.join("config");
    if config_path.exists() {
        let current = fs::read_to_string(&config_path).unwrap_or_default();
        let start_marker = format!("# >>> EasyConsole {alias}");
        let end_marker = format!("# <<< EasyConsole {alias}");
        if let Some(next) = strip_easy_console_block(&current, &start_marker, &end_marker) {
            write_user_ssh_config(&config_path, &next)?;
        }
    }
    for path in [key_path.clone(), key_path.with_extension("pub")] {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    // The shared key from before per-host keys may also exist; this host's
    // revoke already removed the legacy authorized_keys line (the awk filter
    // matches it), so sweep the local files too.
    let legacy = legacy_vscode_key_path(app)?;
    for path in [legacy.clone(), legacy.with_extension("pub")] {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    remove_vscode_key_record(app, &alias)?;
    Ok(())
}

#[tauri::command]
pub async fn open_vscode_ssh(app: AppHandle, request: SshConnectionRequest) -> Result<(), String> {
    let alias = prepare_vscode_ssh(&app, &request).await?;
    spawn_vscode_ssh(&alias)
}

/// Lists the VS Code Remote-SSH setups this install has configured, newest
/// first, so users can see (and revoke) every key EasyConsole installed.
#[cfg(desktop)]
#[tauri::command]
pub fn list_vscode_ssh_keys(app: AppHandle) -> Result<Vec<VscodeKeyRecord>, String> {
    let path = app_data_file(&app, "vscode-keys.json")?;
    Ok(load_vscode_key_records(&path))
}

/// True when a shared VS Code key from an install that predates per-host keys
/// still exists locally.
#[cfg(desktop)]
#[tauri::command]
pub fn has_legacy_vscode_ssh_key(app: AppHandle) -> Result<bool, String> {
    Ok(legacy_vscode_key_path(&app)?.exists())
}

/// Removes the legacy shared VS Code key from this machine: the key files and
/// every EasyConsole config block that references the legacy identity file.
/// The remote `authorized_keys` line is not touched here (removing it needs
/// the host's own credentials); revoking a host from the task panel removes
/// that host's legacy line as part of the normal revoke.
#[cfg(desktop)]
#[tauri::command]
pub fn cleanup_legacy_vscode_ssh_key(app: AppHandle) -> Result<(), String> {
    let key_path = legacy_vscode_key_path(&app)?;
    let ssh_dir = user_ssh_dir()?;
    let config_path = ssh_dir.join("config");
    if config_path.exists() {
        let current = fs::read_to_string(&config_path).unwrap_or_default();
        if let Some(next) = strip_config_blocks_referencing(&current, &key_path) {
            write_user_ssh_config(&config_path, &next)?;
        }
    }
    for path in [key_path.clone(), key_path.with_extension("pub")] {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Revokes a VS Code Remote-SSH setup. With `remove_remote` the marked key is
/// deleted from the host's `authorized_keys` first (authenticating with the
/// per-host key, falling back to a supplied password); without it only local
/// config and key files are removed.
#[cfg(desktop)]
#[tauri::command]
pub async fn revoke_vscode_ssh(
    app: AppHandle,
    request: SshConnectionRequest,
    remove_remote: bool,
) -> Result<(), String> {
    revoke_vscode_setup(&app, &request, remove_remote).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_alias_part_lowercases_and_strips_noise() {
        assert_eq!(sanitize_alias_part("Task_01 Name!"), "task_01-name");
        assert_eq!(sanitize_alias_part("---"), "");
        assert_eq!(sanitize_alias_part("abc"), "abc");
    }

    #[test]
    fn vscode_ssh_alias_parts_prefers_task_id_and_falls_back_to_target() {
        let request = SshConnectionRequest {
            host: "10.0.0.8".to_string(),
            port: Some("30222".to_string()),
            username: Some("root".to_string()),
            password: None,
            command: None,
            task_id: Some("Task-9".to_string()),
            task_name: None,
            cols: None,
            rows: None,
            connect_timeout_sec: None,
            keepalive_interval_sec: None,
            term_type: None,
            ssh_key_path: None,
            auth_mode: None,
        };
        let (alias, suffix) = vscode_ssh_alias_parts(&request).unwrap();
        assert_eq!(alias, "easyconsole-task-9");
        assert_eq!(suffix, "task-9");

        let bare = SshConnectionRequest {
            host: "10.0.0.8".to_string(),
            port: Some("30222".to_string()),
            username: Some("root".to_string()),
            task_id: None,
            ..request
        };
        let (bare_alias, bare_suffix) = vscode_ssh_alias_parts(&bare).unwrap();
        assert_eq!(bare_alias, "easyconsole-root-10-0-0-8-30222");
        assert_eq!(bare_suffix, "root-10-0-0-8-30222");
    }

    #[test]
    fn strip_config_blocks_referencing_removes_legacy_blocks_only() {
        let identity = std::path::PathBuf::from("C:/app-data/ssh/easyconsole_vscode_ed25519");
        let legacy_identity = identity.to_string_lossy().replace('\\', "/");
        let legacy = format!(
            "# >>> EasyConsole legacy-host\nHost easyconsole-legacy-host\n  HostName 10.0.0.1\n  IdentityFile \"{legacy_identity}\"\n  IdentitiesOnly yes\n# <<< EasyConsole legacy-host\n"
        );
        let keep = "# >>> EasyConsole new-host\nHost easyconsole-new-host\n  HostName 10.0.0.2\n  IdentityFile \"C:/app-data/ssh/easyconsole_vscode_new-host\"\n# <<< EasyConsole new-host\n";
        let unrelated = "Host personal\n  HostName personal.example\n";
        let current = format!("{unrelated}{legacy}{keep}");

        let stripped =
            strip_config_blocks_referencing(&current, &identity).expect("paired markers");

        assert!(stripped.contains("Host personal"));
        assert!(stripped.contains("easyconsole-new-host"));
        assert!(!stripped.contains("easyconsole_vscode_ed25519"));
        assert!(!stripped.contains("legacy-host"));
    }

    #[test]
    fn strip_config_blocks_referencing_keeps_backslash_written_blocks() {
        // Windows-written blocks store the identity with forward slashes, but
        // a hand-edited one may use backslashes; both must be recognized.
        let identity = std::path::PathBuf::from("C:/app-data/ssh/easyconsole_vscode_ed25519");
        let backslash_block = "# >>> EasyConsole old\nHost easyconsole-old\n  IdentityFile \"C:\\app-data\\ssh\\easyconsole_vscode_ed25519\"\n# <<< EasyConsole old\n";
        let stripped =
            strip_config_blocks_referencing(backslash_block, &identity).expect("paired markers");
        assert!(
            stripped.is_empty(),
            "the backslash block must be dropped: {stripped}"
        );
    }

    #[test]
    fn strip_config_blocks_referencing_refuses_unpaired_start_marker() {
        let identity = std::path::PathBuf::from("C:/app-data/ssh/easyconsole_vscode_ed25519");
        let broken = "# >>> EasyConsole old
Host easyconsole-old
";
        assert!(strip_config_blocks_referencing(broken, &identity).is_none());
    }

    #[test]
    fn strip_easy_console_block_removes_only_the_marked_block() {
        let start = "# >>> EasyConsole task-1";
        let end = "# <<< EasyConsole task-1";
        let current = format!(
            "Host personal\n  HostName personal.example\n{start}\nHost task-1\n  HostName 10.0.0.1\n{end}\nHost work\n  HostName work.example\n"
        );

        let stripped = strip_easy_console_block(&current, start, end).expect("paired markers");

        assert_eq!(
            stripped,
            "Host personal\n  HostName personal.example\nHost work\n  HostName work.example\n"
        );
    }

    #[test]
    fn strip_easy_console_block_keeps_unrelated_config_untouched() {
        let current = "Host personal\n  HostName personal.example\n";
        let stripped = strip_easy_console_block(
            current,
            "# >>> EasyConsole task-1",
            "# <<< EasyConsole task-1",
        )
        .expect("no markers");
        assert_eq!(stripped, current);
    }

    #[test]
    fn strip_easy_console_block_refuses_unpaired_start_marker() {
        // A truncated write or a hand-edited file can leave the start marker
        // without its end marker. Everything after it must not be dropped.
        let start = "# >>> EasyConsole task-1";
        let end = "# <<< EasyConsole task-1";
        let current = format!("Host personal\n  HostName personal.example\n{start}\nHost task-1\nHost work\n  HostName work.example\n");

        assert!(strip_easy_console_block(&current, start, end).is_none());
    }
}
