use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_data_file;
use crate::trf;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshHistoryEntryValue {
    id: String,
    host: String,
    port: String,
    username: String,
    task_name: String,
    connected_at: i64,
}

/// Serializes read-modify-write on `ssh-history.json`.
static SSH_HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn ssh_history_lock() -> &'static Mutex<()> {
    SSH_HISTORY_LOCK.get_or_init(|| Mutex::new(()))
}

const MAX_SSH_HISTORY_ENTRIES: usize = 20;

fn load_ssh_history(path: &Path) -> Result<Vec<SshHistoryEntryValue>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| {
        trf!(
            "无法读取 SSH 历史：{error}",
            "Failed to read the SSH history: {error}"
        )
    })?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|error| {
        trf!(
            "SSH 历史格式无法识别：{error}",
            "Unrecognized SSH history format: {error}"
        )
    })
}

/// Write via a temp file + rename so an interrupted write cannot leave
/// truncated JSON behind. `fs::rename` replaces an existing file atomically on
/// both Unix and Windows.
fn write_json_atomically(path: &Path, text: &str, label: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        trf!(
            "无法定位{label}目录",
            "Failed to locate the {label} directory"
        )
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            trf!(
                "无法定位{label}文件名",
                "Failed to locate the {label} file name"
            )
        })?;
    let tmp_path = parent.join(format!("{file_name}.tmp"));
    fs::write(&tmp_path, text).map_err(|error| {
        trf!(
            "无法写入{label}临时文件：{error}",
            "Failed to write the {label} temp file: {error}"
        )
    })?;
    fs::rename(&tmp_path, path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        trf!(
            "无法提交{label}写入：{error}",
            "Failed to commit the {label} write: {error}"
        )
    })
}

fn write_ssh_history(path: &Path, entries: &[SshHistoryEntryValue]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(entries).map_err(|error| {
        trf!(
            "SSH 历史序列化失败：{error}",
            "Failed to serialize the SSH history: {error}"
        )
    })?;
    write_json_atomically(path, &text, &trf!("SSH 历史", "SSH history"))
}

#[tauri::command]
pub fn list_ssh_history(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<SshHistoryEntryValue>, String> {
    crate::require_main_window(window.label())?;
    let path = app_data_file(&app, "ssh-history.json")?;
    load_ssh_history(&path)
}

#[tauri::command]
pub fn add_ssh_history(
    app: AppHandle,
    window: tauri::WebviewWindow,
    host: String,
    port: String,
    username: String,
    task_name: String,
    limit: Option<usize>,
) -> Result<(), String> {
    crate::require_main_or_ssh_window(window.label())?;
    let _guard = ssh_history_lock().lock().map_err(|e| {
        trf!(
            "SSH 历史锁获取失败：{e}",
            "Failed to acquire the SSH history lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "ssh-history.json")?;
    let mut entries = load_ssh_history(&path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    entries.retain(|e| !(e.host == host && e.port == port && e.username == username));
    entries.insert(
        0,
        SshHistoryEntryValue {
            id: format!("hist-{now}"),
            host,
            port,
            username,
            task_name,
            connected_at: now,
        },
    );
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.connected_at));
    // The frontend passes the configured history limit; the constant is only a
    // fallback for callers (or old bundles) that omit it.
    let max_entries = limit.unwrap_or(MAX_SSH_HISTORY_ENTRIES).max(1);
    entries.truncate(max_entries);
    write_ssh_history(&path, &entries)
}

#[tauri::command]
pub fn clear_ssh_history(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::require_main_window(window.label())?;
    let _guard = ssh_history_lock().lock().map_err(|e| {
        trf!(
            "SSH 历史锁获取失败：{e}",
            "Failed to acquire the SSH history lock: {e}"
        )
    })?;
    let path = app_data_file(&app, "ssh-history.json")?;
    write_ssh_history(&path, &[])
}
