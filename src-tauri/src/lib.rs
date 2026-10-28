use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[cfg(desktop)]
use tauri::State;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use std::process::Command;
#[cfg(desktop)]
use {
    tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    tauri::{PhysicalPosition, Position, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent},
};

mod i18n;
mod runtime_storage;
mod runtime_storage_lock;
/// SSH internals. Everything here is implementation detail for the packaged
/// app; `pub` only so `tests/ssh_integration.rs` can drive it against a local
/// mock server.
#[doc(hidden)]
pub mod ssh;

use ssh::history::{add_ssh_history, clear_ssh_history, list_ssh_history};
use ssh::host_key::{clear_known_hosts, confirm_known_host, list_known_hosts, remove_known_host};
use ssh::port_forward::{ssh_start_port_forward, ssh_stop_port_forward};
#[cfg(desktop)]
use ssh::session::{
    close_sessions_for_window, get_ssh_window_request, open_ssh_window, PendingSshWindows,
};
use ssh::session::{open_ssh_session, ssh_close, ssh_resize, ssh_write, SshSessionState};
use ssh::sftp::{
    sftp_cancel, sftp_delete, sftp_download, sftp_list, sftp_mkdir, sftp_register_local_root,
    sftp_rename, sftp_upload,
};
#[cfg(desktop)]
use ssh::terminal_spawn::open_system_ssh_terminal;
#[cfg(desktop)]
use ssh::vscode::{
    cleanup_legacy_vscode_ssh_key, has_legacy_vscode_ssh_key, list_vscode_ssh_keys,
    open_vscode_ssh, revoke_vscode_ssh,
};

/// The webview pushes its active interface language here so the native side can
/// localize the strings it produces itself: SSH/SFTP errors, session events and
/// the Android installer messages.
#[tauri::command]
fn set_locale(locale: String) {
    i18n::set_locale(&locale);
}

const I18N_STORAGE_KEY: &str = "easy-console-language";

pub(crate) fn require_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(trf!(
            "此操作仅允许从主窗口执行",
            "This operation is only available from the main window"
        ))
    }
}

fn can_read_runtime_storage(label: &str, key: &str) -> bool {
    label == "main"
        || ((label == "tray-menu" || label.starts_with("ssh-")) && key == I18N_STORAGE_KEY)
}

/// Localized `format!`. Use this instead of `format!` for every user-facing
/// string so the native side follows the interface language.
///
/// ```text
/// trf!("无法打开浏览器：{error}", "Failed to open browser: {error}")
/// ```
///
/// Both candidates share the argument list, so named captures interleave with
/// positional arguments exactly as they do in `format!`.
macro_rules! trf {
    ($zh:literal, $en:literal) => {
        if $crate::i18n::is_english() {
            format!($en)
        } else {
            format!($zh)
        }
    };
    ($zh:literal, $en:literal, $($arg:tt)*) => {
        if $crate::i18n::is_english() {
            format!($en, $($arg)*)
        } else {
            format!($zh, $($arg)*)
        }
    };
}
pub(crate) use trf;

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

#[cfg(desktop)]
#[derive(Default)]
struct DesktopRuntimeState {
    close_to_tray: Mutex<bool>,
    close_prompt_enabled: Mutex<bool>,
    quit_requested: Mutex<bool>,
}

#[doc(hidden)]
pub fn app_data_file<R: tauri::Runtime>(
    app: &AppHandle<R>,
    filename: &str,
) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| {
        trf!(
            "无法定位应用数据目录：{error}",
            "Failed to locate the app data directory: {error}"
        )
    })?;
    fs::create_dir_all(&dir).map_err(|error| {
        trf!(
            "无法创建应用数据目录：{error}",
            "Failed to create the app data directory: {error}"
        )
    })?;
    Ok(dir.join(filename))
}

/// Sidecar paths for the atomic write: `<name>.tmp` stages the new content,
/// `<name>.bak` snapshots the previous good content.
fn storage_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("runtime-storage.json");
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{file_name}{suffix}"))
}

fn read_string_map_file(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = fs::read_to_string(path).map_err(|error| {
        trf!(
            "无法读取本地数据：{error}",
            "Failed to read local data: {error}"
        )
    })?;
    serde_json::from_str(&text).map_err(|error| {
        trf!(
            "本地数据格式无法识别：{error}",
            "Unrecognized local data format: {error}"
        )
    })
}

#[doc(hidden)]
pub fn load_string_map(path: &Path) -> Result<HashMap<String, String>, String> {
    // A missing primary with an existing backup is the crash window of the
    // previous (rename-based) write algorithm: recover the last good state
    // from the backup instead of starting from an empty map.
    if !path.exists() {
        let bak_path = storage_sidecar_path(path, ".bak");
        if bak_path.exists() {
            return read_string_map_file(&bak_path);
        }
        return Ok(HashMap::new());
    }
    match read_string_map_file(path) {
        Ok(map) => Ok(map),
        Err(primary_error) => {
            let bak_path = storage_sidecar_path(path, ".bak");
            if !bak_path.exists() {
                return Err(primary_error);
            }
            // Surface the primary error when the backup is unusable too.
            read_string_map_file(&bak_path).map_err(|_| primary_error)
        }
    }
}

fn write_synced_storage_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| {
        trf!(
            "无法写入本地数据临时文件：{error}",
            "Failed to write the local data temp file: {error}"
        )
    })?;
    file.write_all(contents).map_err(|error| {
        trf!(
            "无法写入本地数据临时文件：{error}",
            "Failed to write the local data temp file: {error}"
        )
    })?;
    file.sync_all().map_err(|error| {
        trf!(
            "无法同步本地数据临时文件：{error}",
            "Failed to sync the local data temp file: {error}"
        )
    })
}

#[doc(hidden)]
pub fn write_string_map(path: &Path, data: &HashMap<String, String>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(data).map_err(|error| {
        trf!(
            "本地数据序列化失败：{error}",
            "Failed to serialize local data: {error}"
        )
    })?;
    let tmp_path = storage_sidecar_path(path, ".tmp");
    let bak_path = storage_sidecar_path(path, ".bak");

    // Fsync both staged files before replacing either live destination.
    write_synced_storage_file(&tmp_path, text.as_bytes())?;
    if path.exists() {
        let previous = fs::read(path).map_err(|error| {
            trf!(
                "无法备份本地数据：{error}",
                "Failed to back up local data: {error}"
            )
        })?;
        // A recovered write must not copy the damaged primary over the last
        // good backup. Stage the backup separately so its own write failure
        // also leaves both previous snapshots intact.
        if serde_json::from_slice::<HashMap<String, String>>(&previous).is_ok() {
            let bak_tmp_path = storage_sidecar_path(path, ".bak.tmp");
            write_synced_storage_file(&bak_tmp_path, &previous)?;
            fs::rename(&bak_tmp_path, &bak_path).map_err(|error| {
                trf!(
                    "无法备份本地数据：{error}",
                    "Failed to back up local data: {error}"
                )
            })?;
        }
    }

    // On Windows std::fs::rename replaces an existing destination atomically.
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            // The live file was never touched; dropping the staged temp file
            // restores the pre-write state exactly.
            let _ = fs::remove_file(&tmp_path);
            Err(trf!(
                "无法提交本地数据写入：{error}",
                "Failed to commit the local data write: {error}"
            ))
        }
    }
}

fn validate_external_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err(trf!(
            "外部链接为空，无法打开",
            "The external link is empty; cannot open it"
        ));
    }
    if url.chars().any(char::is_control) {
        return Err(trf!(
            "外部链接包含不支持的字符",
            "The external link contains unsupported characters"
        ));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(trf!(
            "仅支持打开 http 或 https 链接",
            "Only http or https links can be opened"
        ));
    }
    Ok(url.to_string())
}

/// UNC / network share paths (`\\host\share`, `\\?\...`).
///
/// Opening one can mount an attacker-controlled SMB share and, for `open`, run
/// a binary straight off it. Neither command has a legitimate need for them.
#[cfg(desktop)]
fn is_unc_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\");
    normalized.starts_with("\\\\")
}

/// Extensions `open_local_path` will hand to the OS handler.
///
/// An allowlist, not a denylist: on Windows the set of directly executable
/// extensions is large and keeps growing (exe, bat, cmd, com, scr, pif, msi,
/// hta, cpl, lnk, reg, vbs, wsf, ps1, ...), so enumerating what is dangerous is
/// a losing game. Remote storage controls the file name of anything the user
/// downloads, so "open the file I just downloaded" must not be able to become
/// "execute a program". Anything not listed here can still be located with
/// `reveal_local_path`, which only selects the file in the file manager.
#[cfg(desktop)]
const OPENABLE_EXTENSIONS: &[&str] = &[
    "txt", "log", "json", "csv", "tsv", "md", "yaml", "yml", "xml", "ini", "conf", "toml", "pdf",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z",
    "rar", "mp4", "mkv", "mov", "mp3", "wav",
];

#[cfg(desktop)]
fn validate_existing_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(trf!(
            "本地路径为空，无法打开",
            "The local path is empty; cannot open it"
        ));
    }
    if path.chars().any(char::is_control) {
        return Err(trf!(
            "本地路径包含不支持的字符",
            "The local path contains unsupported characters"
        ));
    }
    if is_unc_path(path) {
        return Err(trf!(
            "出于安全考虑，不支持访问网络共享路径",
            "Network share paths are not supported for security reasons"
        ));
    }
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(trf!("本地路径不存在", "The local path does not exist"));
    }
    Ok(path)
}

/// Target for "reveal in file manager". Never executes, so only the basics.
#[cfg(desktop)]
fn validate_reveal_target(path: &str) -> Result<PathBuf, String> {
    validate_existing_path(path)
}

/// Target for "open with the system handler". Restricted to inert file types.
#[cfg(desktop)]
fn validate_open_target(path: &str) -> Result<PathBuf, String> {
    let path = validate_existing_path(path)?;
    if path.is_dir() {
        return Ok(path);
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(trf!(
            "出于安全考虑，不支持直接打开该类型文件（.{extension}）。请改用「在文件夹中显示」。",
            "Opening this file type directly (.{extension}) is not supported for security reasons. Use \"Show in folder\" instead."
        ));
    }
    Ok(path)
}

/// Target for a download that does not exist yet.
///
/// Validates the *parent directory* rather than the file. The previous shared
/// validator required the target to already exist, which made this command both
/// unusable for real downloads and, when the target did exist, an
/// overwrite-arbitrary-file primitive.
#[cfg(desktop)]
fn validate_download_target(path: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(trf!(
            "下载目标路径为空",
            "The download target path is empty"
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(trf!(
            "下载目标路径包含不支持的字符",
            "The download target path contains unsupported characters"
        ));
    }
    if is_unc_path(trimmed) {
        return Err(trf!(
            "出于安全考虑，不支持下载到网络共享路径",
            "Downloading to network share paths is not supported for security reasons"
        ));
    }

    let target = PathBuf::from(trimmed);
    let parent = target.parent().ok_or_else(|| {
        trf!(
            "无法定位下载目标目录",
            "Failed to locate the download target directory"
        )
    })?;
    // Canonicalize the parent (it must exist) so `..` segments and symlinks
    // cannot escape the allowed roots.
    let parent = parent.canonicalize().map_err(|error| {
        trf!(
            "下载目标目录不存在：{error}",
            "The download target directory does not exist: {error}"
        )
    })?;
    let file_name = target.file_name().ok_or_else(|| {
        trf!(
            "下载目标缺少文件名",
            "The download target is missing a file name"
        )
    })?;

    let allowed = allowed_roots.iter().any(|root| match root.canonicalize() {
        Ok(root) => parent.starts_with(&root),
        Err(_) => false,
    });
    if !allowed {
        return Err(trf!("出于安全考虑，只能下载到下载目录或应用数据目录", "For security reasons downloads may only target the download directory or the app data directory"));
    }

    Ok(parent.join(file_name))
}

#[cfg(all(desktop, target_os = "windows"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开本地路径：{error}",
                "Failed to open the local path: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "macos"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开本地路径：{error}",
                "Failed to open the local path: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "linux"))]
fn open_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开本地路径：{error}",
                "Failed to open the local path: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "windows"))]
fn reveal_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开所在文件夹：{error}",
                "Failed to open the containing folder: {error}"
            )
        })
}

#[cfg(all(desktop, target_os = "macos"))]
fn reveal_path_with_system(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            trf!(
                "无法打开所在文件夹：{error}",
                "Failed to open the containing folder: {error}"
            )
        })
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
        .map_err(|error| {
            trf!(
                "无法打开所在文件夹：{error}",
                "Failed to open the containing folder: {error}"
            )
        })
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

/// Broadcast to every window after a runtime-storage write lands, so other
/// windows can drop their in-memory cache copy of the written key. `source` is
/// the originating window's label; each window ignores its own broadcasts
/// because its cache was already updated synchronously by the write itself.
const RUNTIME_STORAGE_CHANGED_EVENT: &str = "runtime-storage-changed";

#[derive(Clone, serde::Serialize)]
struct RuntimeStorageChange<'a> {
    key: &'a str,
    source: &'a str,
}

fn broadcast_runtime_storage_change(app: &AppHandle, source: &str, key: &str) {
    let _ = app.emit(
        RUNTIME_STORAGE_CHANGED_EVENT,
        RuntimeStorageChange { key, source },
    );
}

/// Acquire the global storage lock, recovering from poisoning: the state it
/// guards is fully re-derived from disk on every call, so a panicked previous
/// holder leaves nothing inconsistent behind — failing every later storage
/// command until restart would be strictly worse.
fn lock_runtime_storage() -> std::sync::MutexGuard<'static, ()> {
    runtime_storage_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Migration and per-key file I/O run on the blocking pool. The global lock
/// covers the entire operation, including initialization and CAS checks.
#[tauri::command]
async fn runtime_storage_get(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<Option<String>, String> {
    if !can_read_runtime_storage(window.label(), &key) {
        return Err(trf!(
            "此窗口无权读取该本地数据",
            "This window is not allowed to read this local data"
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_runtime_storage();
        let path = runtime_storage_path(&app)?;
        let file_guard = runtime_storage_lock::RuntimeStorageFileLock::acquire(&path)?;
        let result = runtime_storage::RuntimeStore::open(&path)?.get(&key);
        file_guard.ensure_healthy()?;
        result
    })
    .await
    .map_err(|e| {
        trf!(
            "本地数据读取任务失败：{e}",
            "Local data read task failed: {e}"
        )
    })?
}

#[tauri::command]
async fn runtime_storage_set(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
    value: String,
) -> Result<(), String> {
    require_main_window(window.label())?;
    let task_app = app.clone();
    let task_key = key.clone();
    let changed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_runtime_storage();
        let path = runtime_storage_path(&task_app)?;
        let file_guard = runtime_storage_lock::RuntimeStorageFileLock::acquire(&path)?;
        let result = runtime_storage::RuntimeStore::open(&path)?.set(&task_key, &value);
        file_guard.ensure_healthy()?;
        result
    })
    .await
    .map_err(|e| {
        trf!(
            "本地数据写入任务失败：{e}",
            "Local data write task failed: {e}"
        )
    })??;
    if changed {
        broadcast_runtime_storage_change(&app, window.label(), &key);
    }
    Ok(())
}

#[tauri::command]
async fn runtime_storage_remove(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<(), String> {
    require_main_window(window.label())?;
    let task_app = app.clone();
    let task_key = key.clone();
    let existed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_runtime_storage();
        let path = runtime_storage_path(&task_app)?;
        let file_guard = runtime_storage_lock::RuntimeStorageFileLock::acquire(&path)?;
        let result = runtime_storage::RuntimeStore::open(&path)?.remove(&task_key);
        file_guard.ensure_healthy()?;
        result
    })
    .await
    .map_err(|e| {
        trf!(
            "本地数据写入任务失败：{e}",
            "Local data write task failed: {e}"
        )
    })??;
    if existed {
        broadcast_runtime_storage_change(&app, window.label(), &key);
    }
    Ok(())
}

/// Compare-and-swap over the runtime-storage map: applies `next` (insert or
/// remove) only when the stored value equals `expected`. Returns `(true, None)`
/// on success and `(false, Some(current))` on mismatch so the caller can retry
/// against the authoritative value without a second read.
#[doc(hidden)]
pub fn apply_storage_cas(
    data: &mut HashMap<String, String>,
    key: &str,
    expected: Option<&str>,
    next: Option<&str>,
) -> (bool, Option<String>) {
    let current = data.get(key).map(String::as_str);
    if current != expected {
        return (false, current.map(ToOwned::to_owned));
    }
    match next {
        Some(value) => {
            data.insert(key.to_owned(), value.to_owned());
        }
        None => {
            data.remove(key);
        }
    }
    (true, None)
}

#[derive(serde::Serialize)]
struct StorageCasOutcome {
    updated: bool,
    current: Option<String>,
}

/// Cross-window-safe read-modify-write primitive. The whole compare-and-swap
/// over a key's file runs under the global lock, so two windows transforming
/// the same key cannot silently overwrite each other: the loser gets the fresh value
/// back (`updated: false`) and retries in JS. `navigator.locks` cannot be
/// relied on here because webview lock scopes are not guaranteed to be shared
/// across windows on every platform backend.
#[tauri::command]
async fn runtime_storage_compare_and_swap(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
    expected: Option<String>,
    next: Option<String>,
    migrate_if_missing: Option<bool>,
) -> Result<StorageCasOutcome, String> {
    require_main_window(window.label())?;
    let task_app = app.clone();
    let task_key = key.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_runtime_storage();
        let path = runtime_storage_path(&task_app)?;
        let file_guard = runtime_storage_lock::RuntimeStorageFileLock::acquire(&path)?;
        let store = runtime_storage::RuntimeStore::open(&path)?;
        let (updated, current) = if migrate_if_missing == Some(true) {
            store.migrate_if_missing(&task_key, next.as_deref())?
        } else {
            store.compare_and_swap(&task_key, expected.as_deref(), next.as_deref())?
        };
        file_guard.ensure_healthy()?;
        Ok::<StorageCasOutcome, String>(StorageCasOutcome { updated, current })
    })
    .await
    .map_err(|e| {
        trf!(
            "本地数据写入任务失败：{e}",
            "Local data write task failed: {e}"
        )
    })??;
    if outcome.updated {
        broadcast_runtime_storage_change(&app, window.label(), &key);
    }
    Ok(outcome)
}

#[cfg(desktop)]
const KEYCHAIN_SERVICE: &str = "easy-console";

#[cfg(desktop)]
fn keychain_service(identifier: &str) -> String {
    if identifier == "com.easyconsole.desktop" {
        KEYCHAIN_SERVICE.into()
    } else {
        format!("{KEYCHAIN_SERVICE}.{identifier}")
    }
}

/// Keep blocking platform keystore calls off the UI thread. Queue operations
/// before dispatching them so writes and removals stay ordered. The worker
/// owns the guard until it finishes, even if its awaiting caller is cancelled.
#[cfg(desktop)]
async fn run_keychain_operation<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    static LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    let guard = Arc::clone(LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(()))))
        .lock_owned()
        .await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        operation()
    })
    .await
    .map_err(|e| trf!("系统钥匙串任务失败：{e}", "Keychain task failed: {e}"))?
}

#[cfg(desktop)]
#[tauri::command]
async fn keychain_get(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<Option<String>, String> {
    require_main_window(window.label())?;
    keychain_get_for_service(keychain_service(&app.config().identifier), key).await
}

#[cfg(desktop)]
async fn keychain_get_for_service(service: String, key: String) -> Result<Option<String>, String> {
    run_keychain_operation(move || {
        let entry = keyring::Entry::new(&service, &key).map_err(|e| {
            trf!(
                "无法访问系统钥匙串：{e}",
                "keychain entry lookup failed: {e}"
            )
        })?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(trf!("读取系统钥匙串失败：{e}", "keychain get failed: {e}")),
        }
    })
    .await
}

#[cfg(desktop)]
#[tauri::command]
async fn keychain_set(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
    value: String,
) -> Result<(), String> {
    require_main_window(window.label())?;
    keychain_set_for_service(keychain_service(&app.config().identifier), key, value).await
}

#[cfg(desktop)]
async fn keychain_set_for_service(
    service: String,
    key: String,
    value: String,
) -> Result<(), String> {
    run_keychain_operation(move || {
        let entry = keyring::Entry::new(&service, &key).map_err(|e| {
            trf!(
                "无法访问系统钥匙串：{e}",
                "keychain entry lookup failed: {e}"
            )
        })?;
        entry
            .set_password(&value)
            .map_err(|e| trf!("写入系统钥匙串失败：{e}", "keychain set failed: {e}"))
    })
    .await
}

#[cfg(desktop)]
#[tauri::command]
async fn keychain_remove(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<(), String> {
    require_main_window(window.label())?;
    keychain_remove_for_service(keychain_service(&app.config().identifier), key).await
}

#[cfg(desktop)]
async fn keychain_remove_for_service(service: String, key: String) -> Result<(), String> {
    run_keychain_operation(move || {
        let entry = keyring::Entry::new(&service, &key).map_err(|e| {
            trf!(
                "无法访问系统钥匙串：{e}",
                "keychain entry lookup failed: {e}"
            )
        })?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(trf!(
                "删除系统钥匙串凭据失败：{e}",
                "keychain remove failed: {e}"
            )),
        }
    })
    .await
}

/// Reads both close preferences from the current store, or from the legacy
/// snapshot before migration. Startup never migrates data on the UI thread.
/// Returns `(close_to_tray, close_prompt)` with defaults `false` and `true`.
#[cfg(desktop)]
fn read_close_settings(app: &AppHandle) -> Result<(bool, bool), String> {
    let path = runtime_storage_path(app)?;
    // Read an atomically published snapshot only. Startup runs on the UI
    // thread and must not wait on another process's transaction or migrate.
    let Some(raw) =
        runtime_storage::RuntimeStore::read_existing_value(&path, APP_SETTINGS_STORAGE_KEY)?
    else {
        return Ok((false, true));
    };
    let value = serde_json::from_str::<serde_json::Value>(&raw)
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
        .map_err(|_| trf!("桌面运行状态已损坏", "The desktop run state is corrupted"))?;
    *close_to_tray = enabled;
    Ok(())
}

#[cfg(desktop)]
fn set_close_prompt_state(state: &Arc<DesktopRuntimeState>, enabled: bool) -> Result<(), String> {
    let mut close_prompt_enabled = state.close_prompt_enabled.lock().map_err(|_| {
        trf!(
            "桌面关闭确认状态已损坏",
            "The desktop close-confirmation state is corrupted"
        )
    })?;
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
    state
        .quit_requested
        .lock()
        .map(|value| *value)
        .unwrap_or(false)
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
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(
            x as i32, y as i32,
        )));
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
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|error| {
            trf!(
                "无法打开外部链接：{error}",
                "Failed to open the external link: {error}"
            )
        })
}

#[cfg(target_os = "android")]
#[tauri::command]
fn mobile_app_arch() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "aarch64" => Ok("aarch64"),
        "x86_64" => Ok("x86_64"),
        architecture => Err(trf!(
            "不支持的 Android 架构：{architecture}",
            "Unsupported Android architecture: {architecture}"
        )),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn install_apk(app: AppHandle, path: String) -> Result<String, String> {
    use jni::objects::{JObject, JString, JValue};
    use std::io::Read;
    use tokio::sync::oneshot;

    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(trf!(
            "APK 文件不存在：{path}",
            "The APK file does not exist: {path}"
        ));
    }
    if !file_path.is_file()
        || file_path
            .extension()
            .and_then(|extension| extension.to_str())
            .map_or(true, |extension| !extension.eq_ignore_ascii_case("apk"))
    {
        return Err(trf!(
            "更新文件不是有效的 APK",
            "The update file is not a valid APK"
        ));
    }

    let updates_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| {
            trf!(
                "无法定位应用缓存目录：{error}",
                "Failed to locate the app cache directory: {error}"
            )
        })?
        .join("updates")
        .canonicalize()
        .map_err(|error| {
            trf!(
                "无法访问更新缓存目录：{error}",
                "Failed to access the update cache directory: {error}"
            )
        })?;
    let canonical_file_path = file_path.canonicalize().map_err(|error| {
        trf!(
            "无法访问 APK 文件：{error}",
            "Failed to access the APK file: {error}"
        )
    })?;
    if !canonical_file_path.starts_with(&updates_dir) {
        return Err(trf!(
            "只允许安装应用更新缓存目录中的 APK",
            "Only APKs in the app update cache directory can be installed"
        ));
    }

    let mut apk_file = fs::File::open(&canonical_file_path).map_err(|error| {
        trf!(
            "无法读取 APK 文件：{error}",
            "Failed to read the APK file: {error}"
        )
    })?;
    let mut signature = [0_u8; 4];
    apk_file.read_exact(&mut signature).map_err(|error| {
        trf!(
            "无法验证 APK 文件：{error}",
            "Failed to verify the APK file: {error}"
        )
    })?;
    if signature != [0x50, 0x4b, 0x03, 0x04] {
        return Err(trf!(
            "更新文件不是有效的 APK",
            "The update file is not a valid APK"
        ));
    }
    let path = canonical_file_path.to_string_lossy().into_owned();

    let window = app.get_webview_window("main").ok_or_else(|| {
        trf!(
            "无法获取 Android 主窗口",
            "Failed to get the Android main window"
        )
    })?;
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = (|| -> Result<String, String> {
                    let java_path = env.new_string(path).map_err(|error| {
                        trf!(
                            "无法编码 APK 路径：{error}",
                            "Failed to encode the APK path: {error}"
                        )
                    })?;
                    let java_path_object = JObject::from(java_path);
                    let value = env
                        .call_method(
                            activity,
                            "installApk",
                            "(Ljava/lang/String;)Ljava/lang/String;",
                            &[JValue::Object(&java_path_object)],
                        )
                        .map_err(|error| {
                            trf!(
                                "无法调用 Android 安装器：{error}",
                                "Failed to invoke the Android installer: {error}"
                            )
                        })?;
                    let response_object = value.l().map_err(|error| {
                        trf!(
                            "Android 安装器返回值无效：{error}",
                            "The Android installer returned an invalid value: {error}"
                        )
                    })?;
                    if response_object.is_null() {
                        return Err(trf!(
                            "Android 安装器未返回状态",
                            "The Android installer did not return a status"
                        ));
                    }
                    let response = String::from(
                        env.get_string(&JString::from(response_object))
                            .map_err(|error| {
                                trf!(
                                    "无法读取 Android 安装状态：{error}",
                                    "Failed to read the Android install status: {error}"
                                )
                            })?,
                    );
                    if let Some(error) = response.strip_prefix("error:") {
                        Err(trf!(
                            "无法触发 APK 安装：{error}",
                            "Failed to trigger the APK install: {error}"
                        ))
                    } else {
                        Ok(response)
                    }
                })();
                let _ = sender.send(result);
            });
        })
        .map_err(|error| {
            trf!(
                "无法调度 Android 安装器：{error}",
                "Failed to schedule the Android installer: {error}"
            )
        })?;

    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| {
            trf!(
                "Android 安装器调用超时",
                "The Android installer call timed out"
            )
        })?
        .map_err(|_| {
            trf!(
                "Android 安装器调用被中断",
                "The Android installer call was interrupted"
            )
        })?
}

#[cfg(desktop)]
#[tauri::command]
async fn http_download_to_file(app: AppHandle, url: String, path: String) -> Result<u64, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut allowed_roots = Vec::new();
    if let Ok(dir) = app.path().download_dir() {
        allowed_roots.push(dir);
    }
    if let Ok(dir) = app.path().app_data_dir() {
        allowed_roots.push(dir);
    }
    let path = validate_download_target(&path, &allowed_roots)?;
    let part_path = format!("{}.part", path.display());
    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|error| {
            trf!(
                "下载请求失败：{error}",
                "The download request failed: {error}"
            )
        })?
        .error_for_status()
        .map_err(|error| trf!("下载响应错误：{error}", "Download response error: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&part_path).await.map_err(|error| {
        trf!(
            "创建临时文件失败：{error}",
            "Failed to create the temp file: {error}"
        )
    })?;
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| {
            trf!(
                "下载流中断：{error}",
                "The download stream was interrupted: {error}"
            )
        })?;
        file.write_all(&bytes).await.map_err(|error| {
            trf!(
                "写入本地文件失败：{error}",
                "Failed to write the local file: {error}"
            )
        })?;
        written += bytes.len() as u64;
    }
    file.flush().await.map_err(|error| {
        trf!(
            "刷新本地文件失败：{error}",
            "Failed to flush the local file: {error}"
        )
    })?;
    drop(file);
    tokio::fs::rename(&part_path, &path)
        .await
        .map_err(|error| {
            trf!(
                "完成下载重命名失败：{error}",
                "Failed to rename the completed download: {error}"
            )
        })?;
    Ok(written)
}

#[cfg(desktop)]
#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    let path = validate_open_target(&path)?;
    open_path_with_system(&path)
}

#[cfg(desktop)]
#[tauri::command]
fn reveal_local_path(path: String) -> Result<(), String> {
    let path = validate_reveal_target(&path)?;
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
        _ => Err(trf!(
            "未知关闭操作",
            "Invalid window close action requested"
        )),
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
    #[cfg(desktop)]
    let pending_ssh_windows = Arc::new(PendingSshWindows::default());
    let ssh_state = Arc::new(SshSessionState::default());

    log::info!("creating Tauri builder");
    let mut builder = tauri::Builder::default().manage(Arc::clone(&ssh_state));

    #[cfg(desktop)]
    {
        builder = builder
            .manage(Arc::clone(&desktop_state))
            .manage(Arc::clone(&pending_ssh_windows))
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
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
    // Release builds persist rolling files under the OS log directory (Info+).
    // Never log tokens, passwords, or private keys into these sinks.
    {
        let mut log_builder = tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .max_file_size(5_000_000)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("easyconsole".into()),
                },
            ));
        if cfg!(debug_assertions) {
            log_builder = log_builder.target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ));
        }
        builder = builder.plugin(log_builder.build());
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
                let (close_to_tray, close_prompt) =
                    read_close_settings(app.handle()).unwrap_or((false, true));
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
        set_locale,
        open_external_url,
        runtime_storage_get,
        runtime_storage_set,
        runtime_storage_remove,
        runtime_storage_compare_and_swap,
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
        sftp_register_local_root,
        sftp_upload,
        sftp_download,
        sftp_delete,
        sftp_rename,
        sftp_mkdir,
        sftp_cancel,
        ssh_start_port_forward,
        ssh_stop_port_forward,
        #[cfg(desktop)]
        open_ssh_window,
        #[cfg(desktop)]
        get_ssh_window_request,
        list_known_hosts,
        confirm_known_host,
        remove_known_host,
        clear_known_hosts,
        list_ssh_history,
        add_ssh_history,
        clear_ssh_history,
        #[cfg(target_os = "android")]
        mobile_app_arch,
        #[cfg(target_os = "android")]
        install_apk,
        #[cfg(desktop)]
        open_system_ssh_terminal,
        #[cfg(desktop)]
        open_vscode_ssh,
        #[cfg(desktop)]
        list_vscode_ssh_keys,
        #[cfg(desktop)]
        has_legacy_vscode_ssh_key,
        #[cfg(desktop)]
        cleanup_legacy_vscode_ssh_key,
        #[cfg(desktop)]
        revoke_vscode_ssh,
        #[cfg(desktop)]
        open_local_path,
        #[cfg(desktop)]
        http_download_to_file,
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
            handle_desktop_event(
                app,
                &event,
                &desktop_state,
                &ssh_state,
                &pending_ssh_windows,
            );
        }
        #[cfg(not(desktop))]
        {
            let _ = (app, event, &ssh_state);
        }
    });
}

#[cfg(desktop)]
fn handle_desktop_event(
    app: &AppHandle,
    event: &RunEvent,
    desktop_state: &Arc<DesktopRuntimeState>,
    ssh_state: &Arc<SshSessionState>,
    pending_ssh_windows: &Arc<PendingSshWindows>,
) {
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
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if label.starts_with("ssh-") => {
            close_sessions_for_window(ssh_state, label);
            // Also drop any connection request this window never retrieved:
            // it contains the plaintext password and must not linger in
            // memory for the rest of the process lifetime.
            pending_ssh_windows.remove_request(label);
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

    /// The active locale is process-global, so tests that touch it must not
    /// run concurrently; tests within a binary run in parallel by default.
    static LOCALE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn storage_roundtrips_and_leaves_a_backup_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        let mut data = HashMap::new();
        data.insert("alpha".to_string(), "1".to_string());
        write_string_map(&path, &data).expect("first write");

        data.insert("beta".to_string(), "2".to_string());
        write_string_map(&path, &data).expect("second write");

        assert_eq!(load_string_map(&path).expect("reload"), data);
        // The backup still holds the previous good content, not the new one.
        let bak = load_string_map(&storage_sidecar_path(&path, ".bak")).expect("backup");
        assert_eq!(bak.get("beta"), None);
        assert_eq!(bak.get("alpha").map(String::as_str), Some("1"));
        // The staged temp file never lingers after a committed write.
        assert!(!storage_sidecar_path(&path, ".tmp").exists());
    }

    #[test]
    fn storage_recovers_from_a_corrupt_primary_via_the_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        let mut data = HashMap::new();
        data.insert("alpha".to_string(), "1".to_string());
        write_string_map(&path, &data).expect("write");
        data.insert("beta".to_string(), "2".to_string());
        write_string_map(&path, &data).expect("write");

        // Simulate a torn write: the primary is damaged, the backup holds the
        // previous good state.
        fs::write(&path, "{\"alpha\": \"trunc").expect("damage");
        assert_eq!(
            load_string_map(&path)
                .expect("backup recovery")
                .get("alpha")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn storage_recovers_from_a_missing_primary_via_the_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        let mut data = HashMap::new();
        data.insert("alpha".to_string(), "1".to_string());
        write_string_map(&path, &data).expect("write");
        data.insert("beta".to_string(), "2".to_string());
        write_string_map(&path, &data).expect("write");

        // The crash window of the old rename-based algorithm: the primary was
        // renamed away and never replaced.
        fs::remove_file(&path).expect("remove primary");
        let recovered = load_string_map(&path).expect("backup recovery");
        assert_eq!(recovered.get("alpha").map(String::as_str), Some("1"));
        assert_eq!(recovered.get("beta"), None);
    }

    #[test]
    fn storage_reports_corruption_when_no_backup_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        for damage in ["not json", "", " \n"] {
            fs::write(&path, damage).expect("damage");
            assert!(load_string_map(&path).is_err());
        }
    }

    #[test]
    fn storage_treats_a_missing_store_as_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        assert!(load_string_map(&path).expect("fresh start").is_empty());
    }

    #[test]
    fn storage_recovers_from_an_empty_primary_via_the_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "backup".to_string())]),
        )
        .unwrap();
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "newer".to_string())]),
        )
        .unwrap();
        fs::write(&path, " \n").unwrap();
        assert_eq!(
            load_string_map(&path)
                .unwrap()
                .get("key")
                .map(String::as_str),
            Some("backup")
        );
    }

    #[test]
    fn storage_never_replaces_a_good_backup_with_a_corrupt_primary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "backup".to_string())]),
        )
        .unwrap();
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "newer".to_string())]),
        )
        .unwrap();
        fs::write(&path, [0xff, 0xfe]).unwrap();
        let mut recovered = load_string_map(&path).unwrap();
        recovered.insert("another".to_string(), "value".to_string());
        write_string_map(&path, &recovered).unwrap();
        fs::write(&path, "broken again").unwrap();
        assert_eq!(
            load_string_map(&path)
                .unwrap()
                .get("key")
                .map(String::as_str),
            Some("backup")
        );
    }

    #[test]
    fn storage_backup_failure_leaves_the_previous_backup_and_primary_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("store.json");
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "backup".to_string())]),
        )
        .unwrap();
        write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "current".to_string())]),
        )
        .unwrap();
        let backup_path = storage_sidecar_path(&path, ".bak");
        let backup = fs::read(&backup_path).unwrap();
        fs::create_dir(storage_sidecar_path(&path, ".bak.tmp")).unwrap();
        assert!(write_string_map(
            &path,
            &HashMap::from([("key".to_string(), "next".to_string())])
        )
        .is_err());
        assert_eq!(fs::read(backup_path).unwrap(), backup);
        assert_eq!(
            load_string_map(&path)
                .unwrap()
                .get("key")
                .map(String::as_str),
            Some("current")
        );
    }
    #[test]
    fn storage_cas_applies_expected_writes_and_reports_conflicts() {
        let mut data = HashMap::new();
        data.insert("k".to_string(), "v1".to_string());

        // Mismatch: report the authoritative value, change nothing.
        let (updated, current) = apply_storage_cas(&mut data, "k", Some("stale"), Some("v2"));
        assert!(!updated);
        assert_eq!(current.as_deref(), Some("v1"));
        assert_eq!(data.get("k").map(String::as_str), Some("v1"));

        // Match: insert the new value.
        let (updated, current) = apply_storage_cas(&mut data, "k", Some("v1"), Some("v2"));
        assert!(updated);
        assert_eq!(current, None);
        assert_eq!(data.get("k").map(String::as_str), Some("v2"));

        // Remove via a `None` next when the expectation matches.
        let (updated, _) = apply_storage_cas(&mut data, "k", Some("v2"), None);
        assert!(updated);
        assert!(!data.contains_key("k"));

        // Insert into a missing key with a `None` expectation.
        let (updated, current) = apply_storage_cas(&mut data, "k", None, Some("fresh"));
        assert!(updated);
        assert_eq!(current, None);
        assert_eq!(data.get("k").map(String::as_str), Some("fresh"));

        // A `Some` expectation against a missing key must conflict, not insert.
        let (updated, current) = apply_storage_cas(&mut data, "other", Some("x"), Some("y"));
        assert!(!updated);
        assert_eq!(current, None);
        assert!(!data.contains_key("other"));
    }

    #[test]
    fn storage_change_broadcast_payload_carries_key_and_source() {
        let payload = RuntimeStorageChange {
            key: "easy-console.runLogs",
            source: "main",
        };
        let json = serde_json::to_value(&payload).expect("serialize failed");
        assert_eq!(json["key"], "easy-console.runLogs");
        assert_eq!(json["source"], "main");
    }

    /// Kept as a single test because the active locale is process-global and
    /// tests within a binary run concurrently.
    #[test]
    fn locale_selects_the_expected_dictionary() {
        let _guard = LOCALE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        i18n::set_locale("en-US");
        assert!(i18n::is_english());
        assert_eq!(trf!("结果：{}", "Result: {}", 7), "Result: 7");

        // Region variants follow the language, as `normalizeLocale()` does in TS.
        i18n::set_locale("en-GB");
        assert!(i18n::is_english());

        i18n::set_locale("zh-CN");
        assert!(!i18n::is_english());
        assert_eq!(trf!("结果：{}", "Result: {}", 7), "结果：7");

        i18n::set_locale("zh-TW");
        assert!(!i18n::is_english());

        // Unknown languages fall back to Chinese, the primary interface language.
        i18n::set_locale("fr-FR");
        assert!(!i18n::is_english());

        i18n::set_locale("zh-CN");
    }

    /// The `set_locale` command is a thin wrapper over `i18n::set_locale`, but it
    /// is the exact function the webview invokes, so keep it pinned. The full IPC
    /// round-trip needs a window and is covered by `npm run tauri:dev`.
    #[test]
    fn set_locale_command_updates_the_native_locale() {
        let _guard = LOCALE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        i18n::set_locale("zh-CN");
        assert!(!i18n::is_english());

        set_locale("en-US".to_string());
        assert!(i18n::is_english());

        set_locale("zh-CN".to_string());
        assert!(!i18n::is_english());
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn keychain_operations_run_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = run_keychain_operation(|| Ok(std::thread::current().id()))
            .await
            .expect("keychain worker failed");
        assert_ne!(worker, caller);
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn keychain_operation_errors_reach_the_caller() {
        let error = run_keychain_operation(|| Err::<(), _>("keystore unavailable".to_string()))
            .await
            .expect_err("the platform error must be returned");
        assert_eq!(error, "keystore unavailable");
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn keychain_worker_panic_does_not_block_later_operations() {
        let error = run_keychain_operation(|| -> Result<(), String> {
            panic!("test keychain worker panic");
        })
        .await
        .expect_err("the worker panic must become a command error");
        assert!(error.contains("test keychain worker panic"));
        run_keychain_operation(|| Ok(()))
            .await
            .expect("the queue must still work after a worker panic");
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn cancelled_keychain_caller_keeps_its_write_ahead_of_removal() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let write_events = Arc::clone(&events);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let write = tokio::spawn(run_keychain_operation(move || {
            entered_tx.send(()).expect("notify worker started");
            release_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("release the blocked test write");
            write_events.lock().unwrap().push("write");
            Ok(())
        }));
        entered_rx.await.expect("wait for test write to start");
        write.abort();
        assert!(write
            .await
            .expect_err("caller must be cancelled")
            .is_cancelled());

        let remove_events = Arc::clone(&events);
        let remove = run_keychain_operation(move || {
            remove_events.lock().unwrap().push("remove");
            Ok(())
        });
        tokio::pin!(remove);
        assert!(futures_util::poll!(&mut remove).is_pending());
        release_tx.send(()).expect("finish test write");
        remove.await.expect("queued removal failed");
        assert_eq!(*events.lock().unwrap(), ["write", "remove"]);
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn keychain_roundtrip_uses_persistent_platform_store() {
        let key = format!("easy-console-selftest-{}", uuid::Uuid::new_v4());

        // The entry must come from a real OS keystore, not the in-memory mock
        // keyring falls back to when no platform feature is enabled.
        let probe =
            keyring::Entry::new(KEYCHAIN_SERVICE, &key).expect("keyring entry creation failed");
        if probe.get_credential().is::<keyring::mock::MockCredential>() {
            panic!("keyring fell back to its in-memory mock keystore; platform keystore features are not enabled");
        }

        // Headless Linux machines may lack a Secret Service daemon; treat that
        // as a skip instead of a failure there.
        match probe.set_password("selftest-probe") {
            Ok(()) => {
                probe
                    .delete_credential()
                    .expect("keychain probe cleanup failed");
            }
            Err(keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_))
                if cfg!(target_os = "linux") =>
            {
                eprintln!("skipping keychain roundtrip: no platform keystore available");
                return;
            }
            Err(e) => panic!("keychain probe write failed: {e}"),
        }

        // Every command call constructs a fresh keyring Entry, so reading back
        // through the commands exercises the same code path as a restart.
        // Clean up before asserting so a failing assertion never leaves the
        // selftest credential behind in the OS keystore.
        keychain_set_for_service(
            KEYCHAIN_SERVICE.into(),
            key.clone(),
            "selftest-secret".to_string(),
        )
        .await
        .expect("keychain set failed");
        let stored = keychain_get_for_service(KEYCHAIN_SERVICE.into(), key.clone()).await;
        let removed = keychain_remove_for_service(KEYCHAIN_SERVICE.into(), key.clone()).await;
        let after_remove = keychain_get_for_service(KEYCHAIN_SERVICE.into(), key.clone()).await;
        let removed_again = keychain_remove_for_service(KEYCHAIN_SERVICE.into(), key).await;

        removed.expect("keychain remove failed");
        removed_again.expect("removing an absent credential must succeed");
        assert_eq!(
            stored.expect("keychain get failed").as_deref(),
            Some("selftest-secret")
        );
        assert_eq!(after_remove.expect("keychain get failed"), None);
    }
}
