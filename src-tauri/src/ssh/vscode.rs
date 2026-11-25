use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::HashAlg;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::app_data_file;
use crate::ssh::host_key::{
    known_host_key, load_known_hosts, ssh_known_hosts_path, EasyConsoleSshClient, KnownHostRecord,
};
use crate::ssh::session::{
    expand_key_path, parse_port, require_username, validate_host, SshConnectionRequest,
};
use crate::trf;

/// Comment marker stamped onto generated keys and recorded in the remote
/// `authorized_keys` line. It helps users identify entries; revocation matches
/// the public key itself so another EasyConsole key is never removed by name.
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

/// Loads the list of keys this install put on hosts. It is the only record of
/// which `authorized_keys` files still hold an EasyConsole key, so a file that
/// cannot be read or parsed is an error, never an empty list: treating it as
/// empty would let the next install or revoke write back a single entry and
/// lose the rest. Only a missing file means "no keys yet".
#[cfg(desktop)]
fn load_vscode_key_records(path: &Path) -> Result<Vec<VscodeKeyRecord>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(trf!(
                "无法读取 VS Code key 记录 {}：{error}",
                "Failed to read the VS Code key records at {}: {error}",
                path.display()
            ))
        }
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| {
        trf!(
            "VS Code key 记录 {} 格式无法识别：{error}。为避免丢失已安装 key 的清单，本次未做任何修改。",
            "The VS Code key records at {} are not in a recognized format: {error}. Nothing was changed, so the list of installed keys is not lost.",
            path.display()
        )
    })
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
    let mut records = load_vscode_key_records(&path)?;
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
    let mut records = load_vscode_key_records(&path)?;
    records.retain(|entry| entry.alias != alias);
    write_vscode_key_records(&path, &records)
}

#[cfg(desktop)]
fn require_password(password: Option<&str>) -> Result<String, String> {
    password
        .filter(|value| !value.trim().is_empty())
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

/// How many dated backups of the user's SSH config are kept.
#[cfg(desktop)]
const SSH_CONFIG_BACKUPS_KEPT: usize = 5;

/// Reads the user's SSH config before EasyConsole rewrites it.
///
/// Only a missing file counts as empty. Any other read error, and a file that
/// is not valid UTF-8 (a GBK comment on a Chinese Windows install, say), aborts:
/// rewriting from an empty view would replace the user's own hosts with the
/// EasyConsole block, or with nothing at all on revoke.
#[cfg(desktop)]
fn read_user_ssh_config(config_path: &Path) -> Result<String, String> {
    match fs::read(config_path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| {
            trf!(
                "本机 SSH 配置 {} 不是 UTF-8 编码，EasyConsole 不会改写它，本次未做任何修改。请将文件另存为 UTF-8 后重试。",
                "The local SSH config {} is not UTF-8 encoded, so EasyConsole will not rewrite it and nothing was changed. Save the file as UTF-8 and retry.",
                config_path.display()
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(trf!(
            "无法读取本机 SSH 配置 {}：{error}。本次未做任何修改。",
            "Failed to read the local SSH config {}: {error}. Nothing was changed.",
            config_path.display()
        )),
    }
}

/// The file a write to `config_path` must replace. A symlinked config (a common
/// dotfiles setup) is written through to its target, so the link survives; a
/// link whose target cannot be resolved is refused rather than replaced.
#[cfg(desktop)]
fn resolve_ssh_config_target(config_path: &Path) -> Result<PathBuf, String> {
    let is_link = fs::symlink_metadata(config_path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if !is_link {
        return Ok(config_path.to_path_buf());
    }
    fs::canonicalize(config_path).map_err(|error| {
        trf!(
            "本机 SSH 配置 {} 是指向无法访问位置的符号链接：{error}。本次未做任何修改。",
            "The local SSH config {} is a symbolic link whose target cannot be reached: {error}. Nothing was changed.",
            config_path.display()
        )
    })
}

/// Copies the current config to `<name>.easy-console.<millis>-<seq>.bak` beside it
/// and prunes all but the newest few dated copies. Each write gets its own
/// backup, so a second write never overwrites the only copy of the original.
#[cfg(desktop)]
fn backup_user_ssh_config(config_path: &Path, source: &Path) -> Result<(), String> {
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
    let prefix = format!("{file_name}.easy-console.");
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // `<millis>-<seq>`: both parts are zero padded, so names sort in write order
    // even when two writes land in the same millisecond.
    let mut attempt = 0u32;
    let mut bak_path = parent.join(format!("{prefix}{millis:013}-{attempt:03}.bak"));
    while bak_path.exists() {
        attempt += 1;
        bak_path = parent.join(format!("{prefix}{millis:013}-{attempt:03}.bak"));
    }
    // fs::copy keeps the source's permissions, so a tightened config stays tight.
    fs::copy(source, &bak_path).map_err(|error| {
        trf!(
            "无法备份本机 SSH 配置：{error}",
            "Failed to back up the local SSH config: {error}"
        )
    })?;
    prune_ssh_config_backups(parent, &prefix);
    Ok(())
}

/// Removes dated backups beyond the newest `SSH_CONFIG_BACKUPS_KEPT`. Only names
/// this module writes are touched; the undated `<name>.easy-console.bak` from
/// older versions is left alone. Best effort: a failed prune never fails a write.
#[cfg(desktop)]
fn prune_ssh_config_backups(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut dated: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| {
            name.strip_prefix(prefix)
                .and_then(|rest| rest.strip_suffix(".bak"))
                .is_some_and(|stamp| {
                    !stamp.is_empty() && stamp.chars().all(|c| c.is_ascii_digit() || c == '-')
                })
        })
        .collect();
    if dated.len() <= SSH_CONFIG_BACKUPS_KEPT {
        return;
    }
    // Zero-padded `<millis>-<seq>` stamps sort chronologically as text.
    dated.sort();
    for name in &dated[..dated.len() - SSH_CONFIG_BACKUPS_KEPT] {
        let _ = fs::remove_file(dir.join(name));
    }
}

/// Replace the user's SSH config atomically, keeping a recoverable copy.
///
/// A plain `fs::write` here is dangerous: a partial write leaves a truncated
/// config, which in turn produces an unpaired EasyConsole marker, which the
/// block parser would then treat as "skip everything after it". That failure
/// mode compounds, so the write must be all-or-nothing.
#[cfg(desktop)]
fn write_user_ssh_config(config_path: &Path, contents: &str) -> Result<(), String> {
    let target = resolve_ssh_config_target(config_path)?;
    let target_parent = target.parent().ok_or_else(|| {
        trf!(
            "无法定位本机 SSH 配置目录",
            "Failed to locate the local SSH config directory"
        )
    })?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    // The temp file sits beside the target so the final rename stays on one
    // filesystem and is atomic.
    let tmp_path = target_parent.join(format!("{file_name}.easy-console.tmp"));

    // Copy (not rename) so the original stays intact until the final rename.
    // Backups live beside the path the user knows (~/.ssh), not in a dotfiles
    // directory the link points into.
    if target.exists() {
        backup_user_ssh_config(config_path, &target)?;
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
        let mode = fs::metadata(&target)
            .ok()
            .map(|meta| meta.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(mode));
    }

    fs::rename(&tmp_path, &target).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        trf!(
            "无法提交本机 SSH 配置写入：{error}",
            "Failed to commit the local SSH config write: {error}"
        )
    })
}

/// Checks, before anything changes on a host, that the local side can be
/// updated afterwards: the SSH config is readable as UTF-8, its EasyConsole
/// block for `alias` is well formed (when `require_paired_block`), and the key
/// records load. A remote step followed by a local failure would leave a key
/// on the host that no config uses or no record lists.
#[cfg(desktop)]
fn preflight_local_vscode_state(
    app: &AppHandle,
    alias: &str,
    require_paired_block: bool,
) -> Result<(), String> {
    let config_path = user_ssh_dir()?.join("config");
    let current = read_user_ssh_config(&config_path)?;
    if require_paired_block {
        let start_marker = format!("# >>> EasyConsole {alias}");
        let end_marker = format!("# <<< EasyConsole {alias}");
        if strip_easy_console_block(&current, &start_marker, &end_marker).is_none() {
            return Err(incomplete_marker_error(
                &start_marker,
                &end_marker,
                &config_path,
            ));
        }
    }
    // An install always writes the config; a revoke only rewrites one that exists.
    if require_paired_block || config_path.exists() {
        resolve_ssh_config_target(&config_path)?;
    }
    load_vscode_key_records(&app_data_file(app, "vscode-keys.json")?)?;
    Ok(())
}

#[cfg(desktop)]
fn incomplete_marker_error(start_marker: &str, end_marker: &str, config_path: &Path) -> String {
    trf!(
        "本机 SSH 配置中的 EasyConsole 标记不完整：找到「{start_marker}」但缺少对应的「{end_marker}」。\
         为避免误删配置，本次未做任何修改。请手动修复 {} 后重试。",
        "Incomplete EasyConsole markers in the local SSH config: found \"{start_marker}\" but the matching \"{end_marker}\" is missing. To avoid deleting config by mistake, nothing was changed. Fix {} manually and retry.",
        config_path.display()
    )
}

#[cfg(desktop)]
fn write_vscode_ssh_config(
    app: &AppHandle,
    request: &SshConnectionRequest,
    alias: &str,
    identity_file: &Path,
) -> Result<(), String> {
    let host = validate_host(&request.host)?;
    let username = require_username(request.username.as_deref())?;
    let port = parse_port(request.port.as_deref())?;
    let host_records = load_known_hosts(app)?;
    let target_key = known_host_key(&host, port);
    let has_pinned_key = host_records
        .get(&target_key)
        .is_some_and(|record| record.public_key.is_some());
    let known_hosts_file = if has_pinned_key {
        Some(write_managed_known_hosts(app, &host_records)?)
    } else {
        None
    };
    let ssh_dir = user_ssh_dir()?;
    fs::create_dir_all(&ssh_dir).map_err(|error| {
        trf!(
            "无法创建本机 SSH 配置目录：{error}",
            "Failed to create the local SSH config directory: {error}"
        )
    })?;
    let config_path = ssh_dir.join("config");
    let current = read_user_ssh_config(&config_path)?;
    let start_marker = format!("# >>> EasyConsole {alias}");
    let end_marker = format!("# <<< EasyConsole {alias}");

    let mut next = strip_easy_console_block(&current, &start_marker, &end_marker)
        .ok_or_else(|| incomplete_marker_error(&start_marker, &end_marker, &config_path))?;

    if !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&format!(
        "{start_marker}\nHost {alias}\n  HostName {host}\n  User {username}\n  Port {port}\n  IdentityFile {}\n  IdentitiesOnly yes\n",
        ssh_config_identity_path(identity_file),
    ));
    next.push_str(&vscode_host_key_options(known_hosts_file.as_deref()));
    next.push_str(&format!("{end_marker}\n"));

    write_user_ssh_config(&config_path, &next)
}

#[cfg(desktop)]
fn vscode_host_key_options(known_hosts_file: Option<&Path>) -> String {
    if let Some(path) = known_hosts_file {
        format!(
            "  UserKnownHostsFile {}\n  StrictHostKeyChecking yes\n",
            ssh_config_identity_path(path),
        )
    } else {
        "  StrictHostKeyChecking accept-new\n".to_string()
    }
}

#[cfg(desktop)]
fn parse_known_host_key(host_port: &str) -> Option<(String, u16)> {
    if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, port) = bracketed.split_once("]:")?;
        return Some((host.to_string(), port.parse().ok()?));
    }
    let (host, port) = host_port.rsplit_once(':')?;
    Some((host.to_string(), port.parse().ok()?))
}

#[cfg(desktop)]
pub fn write_managed_known_hosts<R: Runtime>(
    app: &AppHandle<R>,
    records: &std::collections::HashMap<String, KnownHostRecord>,
) -> Result<PathBuf, String> {
    let path = ssh_known_hosts_path(app)?;
    let mut lines = records
        .iter()
        .filter_map(|(host_port, record)| {
            let public_key = record.public_key.as_deref()?;
            let (host, port) = parse_known_host_key(host_port)?;
            let host_field = if port == 22 {
                host
            } else {
                format!("[{host}]:{port}")
            };
            Some(format!("{host_field} {public_key}"))
        })
        .collect::<Vec<_>>();
    lines.sort();
    let contents = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    let temp = path.with_extension("openssh.tmp");
    let mut file = fs::File::create(&temp).map_err(|error| {
        trf!(
            "无法写入应用管理的 SSH 主机记录：{error}",
            "Failed to write the application-managed SSH host file: {error}"
        )
    })?;
    file.write_all(contents.as_bytes()).map_err(|error| {
        trf!(
            "无法写入应用管理的 SSH 主机记录：{error}",
            "Failed to write the application-managed SSH host file: {error}"
        )
    })?;
    file.sync_all().map_err(|error| {
        trf!(
            "无法同步应用管理的 SSH 主机记录：{error}",
            "Failed to sync the application-managed SSH host file: {error}"
        )
    })?;
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        trf!(
            "无法提交应用管理的 SSH 主机记录：{error}",
            "Failed to commit the application-managed SSH host file: {error}"
        )
    })?;
    Ok(path)
}

#[cfg(desktop)]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(desktop)]
fn public_key_parts(key_path: &Path) -> Result<(String, String), String> {
    let public_key_path = key_path.with_extension("pub");
    let public_key = if public_key_path.is_file() {
        fs::read_to_string(&public_key_path).map_err(|error| {
            trf!(
                "无法读取 VS Code SSH 公钥：{error}",
                "Failed to read the VS Code SSH public key: {error}"
            )
        })?
    } else if key_path.is_file() {
        let output = Command::new("ssh-keygen")
            .args(["-y", "-f"])
            .arg(key_path)
            .output()
            .map_err(|error| {
                trf!(
                    "无法从 VS Code 私钥恢复公钥：{error}",
                    "Failed to recover the VS Code public key from its private key: {error}"
                )
            })?;
        if !output.status.success() {
            return Err(trf!(
                "无法从 VS Code 私钥恢复公钥",
                "Failed to recover the VS Code public key from its private key"
            ));
        }
        String::from_utf8(output.stdout).map_err(|error| {
            trf!(
                "恢复的 VS Code 公钥不是有效文本：{error}",
                "The recovered VS Code public key is not valid text: {error}"
            )
        })?
    } else {
        return Err(trf!(
            "找不到本机 VS Code 公钥或对应私钥；为避免删除其他密钥，未修改远端 authorized_keys",
            "The local VS Code public key and its private key are missing; remote authorized_keys was left unchanged to avoid deleting another key"
        ));
    };

    let line = public_key
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| {
            trf!(
                "VS Code SSH 公钥为空",
                "The VS Code SSH public key is empty"
            )
        })?;
    let mut fields = line.split_ascii_whitespace();
    let key_type = fields.next().unwrap_or_default();
    let key_blob = fields.next().unwrap_or_default();
    if key_type.is_empty()
        || key_blob.is_empty()
        || russh::keys::PublicKey::from_openssh(&format!("{key_type} {key_blob}")).is_err()
    {
        return Err(trf!(
            "VS Code SSH 公钥格式无效；为避免删除其他密钥，未修改远端 authorized_keys",
            "The VS Code SSH public key is invalid; remote authorized_keys was left unchanged to avoid deleting another key"
        ));
    }
    Ok((key_type.to_string(), key_blob.to_string()))
}

#[cfg(desktop)]
fn build_revoke_authorized_keys_script(keys: &[(String, String)]) -> String {
    let key_pairs = keys
        .iter()
        .map(|(key_type, key_blob)| format!("{key_type} {key_blob}"))
        .collect::<Vec<_>>()
        .join("\u{1c}");
    let key_pairs = shell_single_quote(&key_pairs);
    let script = r#"set -eu; umask 077; f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; d=${f%/*}; t=$(mktemp "$d/.authorized_keys.XXXXXX"); trap 'rm -f "$t"' 0; trap 'exit 1' HUP INT TERM; awk -v keys=KEYS 'function parse_fields(line, result,    i, c, quoted, escaped, token, count) { count = 0; token = ""; quoted = 0; escaped = 0; for (i = 1; i <= length(line); i++) { c = substr(line, i, 1); if (escaped) { token = token c; escaped = 0; continue } if (c == "\\") { token = token c; escaped = 1; continue } if (c == "\"") { token = token c; quoted = !quoted; continue } if ((c == " " || c == "\t") && !quoted) { if (token != "") result[++count] = token; token = ""; continue } token = token c } if (token != "") result[++count] = token; return count } BEGIN { n = split(keys, pairs, "\034"); for (j = 1; j <= n; j++) { count = split(pairs[j], pair, " "); types[j] = pair[1]; blobs[j] = pair[2] } } { count = parse_fields($0, tokens); for (i = 1; i < count; i++) for (j = 1; j <= n; j++) if (tokens[i] == types[j] && tokens[i + 1] == blobs[j]) next; print }' "$f" > "$t"; chmod 600 "$t"; mv -f "$t" "$f""#;
    script.replace("KEYS", &key_pairs)
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
async fn connect_for_vscode_setup<R: Runtime>(
    app: &AppHandle<R>,
    request: &SshConnectionRequest,
    operation_label: &str,
) -> Result<client::Handle<EasyConsoleSshClient<R>>, String> {
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
        task_id: request.task_id.clone(),
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
async fn exec_remote_command<R: Runtime>(
    session: client::Handle<EasyConsoleSshClient<R>>,
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
            ChannelMsg::Close => break,
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

#[cfg(feature = "ssh-test-internals")]
pub async fn execute_test_remote_command<R: Runtime>(
    app: AppHandle<R>,
    port: u16,
    command: &str,
) -> Result<(), String> {
    let request = SshConnectionRequest {
        host: "127.0.0.1".to_string(),
        port: Some(port.to_string()),
        username: Some("ubuntu".to_string()),
        password: Some("correct".to_string()),
        command: None,
        task_id: None,
        task_name: None,
        cols: None,
        rows: None,
        connect_timeout_sec: None,
        keepalive_interval_sec: None,
        term_type: None,
        ssh_key_path: None,
        auth_mode: Some("password".to_string()),
    };
    let mut session = connect_for_vscode_setup(&app, &request, "run a test command").await?;
    let auth = crate::ssh::auth::authenticate_password(&mut session, "ubuntu", "correct")
        .await
        .map_err(|error| error.to_string())?;
    if !auth {
        return Err(trf!("SSH 测试认证失败", "SSH test authentication failed"));
    }
    exec_remote_command(session, command, "run a test command").await
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
    let auth = crate::ssh::auth::authenticate_password(&mut session, &username, &password)
        .await
        .map_err(|error| {
            trf!(
                "SSH 认证失败，无法{label}：{error}",
                "SSH authentication failed; cannot {label}: {error}"
            )
        })?;
    if !auth {
        return Err(trf!(
            "SSH 认证失败，无法{label}：用户名或密码不正确",
            "SSH authentication failed; cannot {label}: incorrect username or password"
        ));
    }

    exec_remote_command(session, &command, &label).await
}

/// Removes this host's public key and an identifiable legacy shared key from
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
    let mut keys = vec![public_key_parts(key_path)?];
    // Older versions shared one local key across hosts. Remove that legacy
    // key only when this install still has it and can identify its public key.
    let legacy_key_path = legacy_vscode_key_path(app)?;
    if legacy_key_path.is_file() {
        keys.push(public_key_parts(&legacy_key_path)?);
    }
    let command = build_revoke_authorized_keys_script(&keys);

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
        let auth = crate::ssh::auth::authenticate_password(&mut session, &username, &password)
            .await
            .map_err(|error| {
                trf!(
                    "SSH 认证失败，无法{label}：{error}",
                    "SSH authentication failed; cannot {label}: {error}"
                )
            })?;
        if !auth {
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
    preflight_local_vscode_state(app, &alias, true)?;
    let (identity_file, public_key) = ensure_vscode_key(app, &suffix)?;
    install_vscode_public_key(app, request, &public_key).await?;
    write_vscode_ssh_config(app, request, &alias, &identity_file)?;
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
    // A revoke tolerates a hand-edited block (see below), but not a config it
    // cannot read or records it cannot load: check before the host changes.
    preflight_local_vscode_state(app, &alias, false)?;

    if remove_remote {
        revoke_vscode_remote_key(app, request, &key_path).await?;
    }

    // Remote access is gone (or was left in place by request); now clean up
    // the local side. The config block is removed even if the block markers
    // are missing — a revoke must not be blocked by a hand-edited config.
    let ssh_dir = user_ssh_dir()?;
    let config_path = ssh_dir.join("config");
    if config_path.exists() {
        let current = read_user_ssh_config(&config_path)?;
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
pub async fn open_vscode_ssh(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request: SshConnectionRequest,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let alias = prepare_vscode_ssh(&app, &request).await?;
    spawn_vscode_ssh(&alias)
}

/// Lists the VS Code Remote-SSH setups this install has configured, newest
/// first, so users can see (and revoke) every key EasyConsole installed.
#[cfg(desktop)]
#[tauri::command]
pub fn list_vscode_ssh_keys(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<VscodeKeyRecord>, String> {
    crate::require_main_window(window.label())?;
    let path = app_data_file(&app, "vscode-keys.json")?;
    load_vscode_key_records(&path)
}

/// True when a shared VS Code key from an install that predates per-host keys
/// still exists locally.
#[cfg(desktop)]
#[tauri::command]
pub fn has_legacy_vscode_ssh_key(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    crate::require_main_window(window.label())?;
    Ok(legacy_vscode_key_path(&app)?.exists())
}

/// Removes the legacy shared VS Code key from this machine: the key files and
/// every EasyConsole config block that references the legacy identity file.
/// The remote `authorized_keys` line is not touched here (removing it needs
/// the host's own credentials); revoking a host from the task panel removes
/// that host's legacy line as part of the normal revoke.
#[cfg(desktop)]
#[tauri::command]
pub fn cleanup_legacy_vscode_ssh_key(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let key_path = legacy_vscode_key_path(&app)?;
    let ssh_dir = user_ssh_dir()?;
    let config_path = ssh_dir.join("config");
    if config_path.exists() {
        let current = read_user_ssh_config(&config_path)?;
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

/// Revokes a VS Code Remote-SSH setup. With `remove_remote`, the matching
/// public key is deleted from the host's `authorized_keys` first (authenticating
/// with the per-host key, falling back to a supplied password); without it
/// only local config and key files are removed.
#[cfg(desktop)]
#[tauri::command]
pub async fn revoke_vscode_ssh(
    app: AppHandle,
    window: tauri::WebviewWindow,
    request: SshConnectionRequest,
    remove_remote: bool,
) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    revoke_vscode_setup(&app, &request, remove_remote).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_password_preserves_surrounding_whitespace_and_rejects_blank_values() {
        assert_eq!(
            require_password(Some("  secret \t")).unwrap(),
            "  secret \t"
        );
        assert!(require_password(Some(" \t\n ")).is_err());
        assert!(require_password(None).is_err());
    }

    #[test]
    fn sanitize_alias_part_lowercases_and_strips_noise() {
        assert_eq!(sanitize_alias_part("Task_01 Name!"), "task_01-name");
        assert_eq!(sanitize_alias_part("---"), "");
        assert_eq!(sanitize_alias_part("abc"), "abc");
    }

    #[test]
    fn parses_known_host_addresses_for_openssh_format() {
        assert_eq!(
            parse_known_host_key("example.com:22"),
            Some(("example.com".into(), 22))
        );
        assert_eq!(
            parse_known_host_key("example.com:2222"),
            Some(("example.com".into(), 2222))
        );
        assert_eq!(
            parse_known_host_key("[2001:db8::1]:2200"),
            Some(("2001:db8::1".into(), 2200))
        );
        assert_eq!(parse_known_host_key("invalid"), None);
    }

    #[test]
    fn pins_vscode_to_the_managed_host_file_when_a_full_key_is_available() {
        let pinned = vscode_host_key_options(Some(Path::new("C:/app/known-ssh-hosts.openssh")));
        assert!(pinned.contains("UserKnownHostsFile \"C:/app/known-ssh-hosts.openssh\""));
        assert!(pinned.contains("StrictHostKeyChecking yes"));

        let legacy = vscode_host_key_options(None);
        assert!(legacy.contains("StrictHostKeyChecking accept-new"));
        assert!(!legacy.contains("UserKnownHostsFile"));
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

    #[cfg(unix)]
    #[test]
    fn reads_a_missing_config_as_empty_and_refuses_a_non_utf8_one() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        assert_eq!(read_user_ssh_config(&config).unwrap(), "");

        fs::write(&config, "Host box\n  HostName 10.0.0.2\n").unwrap();
        assert_eq!(
            read_user_ssh_config(&config).unwrap(),
            "Host box\n  HostName 10.0.0.2\n"
        );

        // "# 中文注释" saved as GBK, as Notepad does on a Chinese Windows install.
        let mut gbk = b"# ".to_vec();
        gbk.extend_from_slice(&[0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd]);
        gbk.extend_from_slice(b"\nHost box\n  HostName 10.0.0.2\n");
        fs::write(&config, &gbk).unwrap();
        assert!(read_user_ssh_config(&config).is_err());
        // Refusing to read leaves the file exactly as it was.
        assert_eq!(fs::read(&config).unwrap(), gbk);
    }

    #[test]
    fn keeps_a_dated_backup_per_write_and_prunes_to_the_newest_few() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        fs::write(&config, "Host original\n").unwrap();
        // An undated backup from an older version must survive pruning.
        fs::write(dir.path().join("config.easy-console.bak"), "legacy").unwrap();

        write_user_ssh_config(&config, "Host first\n").unwrap();
        write_user_ssh_config(&config, "Host second\n").unwrap();

        let backups = |dir: &Path| {
            let mut names: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| name.starts_with("config.easy-console.") && name.ends_with(".bak"))
                .filter(|name| name != "config.easy-console.bak")
                .collect();
            names.sort();
            names
        };
        let first_two = backups(dir.path());
        assert_eq!(first_two.len(), 2);
        // The second write did not overwrite the copy of the original.
        let contents: Vec<String> = first_two
            .iter()
            .map(|name| fs::read_to_string(dir.path().join(name)).unwrap())
            .collect();
        assert!(contents.contains(&"Host original\n".to_string()));
        assert!(contents.contains(&"Host first\n".to_string()));
        assert_eq!(fs::read_to_string(&config).unwrap(), "Host second\n");

        for index in 0..SSH_CONFIG_BACKUPS_KEPT + 3 {
            write_user_ssh_config(&config, &format!("Host round-{index}\n")).unwrap();
        }
        assert_eq!(backups(dir.path()).len(), SSH_CONFIG_BACKUPS_KEPT);
        assert_eq!(
            fs::read_to_string(dir.path().join("config.easy-console.bak")).unwrap(),
            "legacy"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_symlinked_config_through_to_its_target() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = home.path().join("dotfiles");
        let ssh_dir = home.path().join(".ssh");
        fs::create_dir_all(&dotfiles).unwrap();
        fs::create_dir_all(&ssh_dir).unwrap();
        let target = dotfiles.join("ssh_config");
        fs::write(&target, "Host original\n").unwrap();
        let link = ssh_dir.join("config");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_user_ssh_config(&link, "Host original\nHost added\n").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "Host original\nHost added\n"
        );
        // The backup sits beside the link in ~/.ssh, not in the dotfiles directory.
        let backup_dirs: Vec<bool> = [&ssh_dir, &dotfiles]
            .iter()
            .map(|dir| {
                fs::read_dir(dir).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".bak")
                })
            })
            .collect();
        assert_eq!(backup_dirs, vec![true, false]);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_replace_a_dangling_config_symlink() {
        let home = tempfile::tempdir().unwrap();
        let link = home.path().join("config");
        std::os::unix::fs::symlink(home.path().join("missing"), &link).unwrap();

        assert!(write_user_ssh_config(&link, "Host added\n").is_err());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn key_records_load_empty_when_missing_and_fail_when_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vscode-keys.json");
        assert!(load_vscode_key_records(&path).unwrap().is_empty());

        let records = vec![VscodeKeyRecord {
            alias: "easyconsole-7".into(),
            host: "10.0.0.2".into(),
            port: "22".into(),
            username: "ubuntu".into(),
            fingerprint: "SHA256:abc".into(),
            installed_at: 1,
        }];
        write_vscode_key_records(&path, &records).unwrap();
        assert_eq!(load_vscode_key_records(&path).unwrap().len(), 1);

        fs::write(&path, "[{\"alias\": \"easyconsole-7\"").unwrap();
        assert!(load_vscode_key_records(&path).is_err());
        // A failed load never rewrites the file.
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[{\"alias\": \"easyconsole-7\""
        );
    }

    #[test]
    fn revoke_script_removes_only_matching_public_keys() {
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        fs::create_dir(&ssh_dir).unwrap();
        let key_dir = home.path().join("keys");
        fs::create_dir(&key_dir).unwrap();
        let target_key = key_dir.join("target");
        let other_key = key_dir.join("other");
        for path in [&target_key, &other_key] {
            let status = Command::new("ssh-keygen")
                .args([
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-C",
                    "easyconsole-vscode:same",
                    "-f",
                ])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let (target_type, target_blob) = public_key_parts(&target_key).unwrap();
        let other_public = fs::read_to_string(other_key.with_extension("pub")).unwrap();
        let authorized_keys = ssh_dir.join("authorized_keys");
        fs::write(
            &authorized_keys,
            format!(
                "restrict,command=\"echo ignored\" {target_type} {target_blob} easyconsole-vscode:same\n{other_public}ssh-rsa KEEP other-key\n"
            ),
        )
        .unwrap();
        let script = build_revoke_authorized_keys_script(&[(target_type, target_blob.clone())]);

        let output = Command::new("sh")
            .arg("-c")
            .arg(script)
            .env("HOME", home.path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let remaining = fs::read_to_string(authorized_keys).unwrap();
        assert!(!remaining.contains(&target_blob));
        assert!(remaining.contains(&other_public));
        assert!(remaining.contains("easyconsole-vscode:same"));
        assert!(remaining.contains("ssh-rsa KEEP other-key"));
    }

    #[cfg(unix)]
    #[test]
    fn revoke_script_preserves_original_file_when_staging_or_filtering_fails() {
        use std::os::unix::fs::PermissionsExt;

        for failing_command in ["mktemp", "awk"] {
            let home = tempfile::tempdir().unwrap();
            let ssh_dir = home.path().join(".ssh");
            let fake_bin = home.path().join("bin");
            fs::create_dir(&ssh_dir).unwrap();
            fs::create_dir(&fake_bin).unwrap();
            let authorized_keys = ssh_dir.join("authorized_keys");
            let original = b"ssh-ed25519 TARGET easyconsole-vscode:one\nssh-rsa KEEP platform\n";
            fs::write(&authorized_keys, original).unwrap();
            let fake_command = fake_bin.join(failing_command);
            let failure_script = if failing_command == "awk" {
                "#!/bin/sh\nprintf partial-output\nexit 1\n"
            } else {
                "#!/bin/sh\nexit 1\n"
            };
            fs::write(&fake_command, failure_script).unwrap();
            fs::set_permissions(&fake_command, fs::Permissions::from_mode(0o700)).unwrap();
            let script = build_revoke_authorized_keys_script(&[(
                "ssh-ed25519".to_string(),
                "TARGET".to_string(),
            )]);

            let output = Command::new("sh")
                .arg("-c")
                .arg(script)
                .env("HOME", home.path())
                .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
                .output()
                .unwrap();

            assert!(
                !output.status.success(),
                "{failing_command} failure must propagate"
            );
            assert_eq!(
                fs::read(authorized_keys).unwrap(),
                original,
                "{failing_command} must not change authorized_keys"
            );
        }
    }
}
