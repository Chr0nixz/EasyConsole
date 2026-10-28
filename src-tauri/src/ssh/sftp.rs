use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::ssh::host_key::EasyConsoleSshClient;
use crate::ssh::session::{
    emit_session_event, send_session_command_with_response, SshCommand, SshSessionState,
};
use crate::trf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntryValue {
    name: String,
    long_name: String,
    is_dir: bool,
    is_file: bool,
    is_symlink: bool,
    size: u64,
    modified_at: i64,
    permissions: String,
}

/// Final, machine-readable result of one SFTP transfer, returned through the
/// invoking command. Progress events are display-only and never a success
/// criterion. Failed transfers reject the command with the error message
/// instead of carrying a `failed` status here.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferOutcome {
    pub transfer_id: String,
    /// "upload" or "download".
    pub operation: &'static str,
    /// "completed" or "canceled".
    pub status: &'static str,
    pub transferred: u64,
    pub total: u64,
}

/// Resolve a user-supplied SFTP path that may use the "~" home shortcut.
/// SFTP protocol does not expand "~" (that's a shell convention), so we
/// canonicalize(".") once to get the absolute home directory and substitute.
async fn resolve_sftp_path(sftp: &SftpSession, path: &str) -> Result<String, String> {
    if path == "~" || path == "~/" {
        return sftp.canonicalize(".").await.map_err(|e| {
            trf!(
                "SFTP 解析家目录失败：{e}",
                "SFTP: failed to resolve the home directory: {e}"
            )
        });
    }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = sftp.canonicalize(".").await.map_err(|e| {
            trf!(
                "SFTP 解析家目录失败：{e}",
                "SFTP: failed to resolve the home directory: {e}"
            )
        })?;
        let rest = rest.trim_start_matches('/');
        return Ok(if home.ends_with('/') {
            format!("{home}{rest}")
        } else {
            format!("{home}/{rest}")
        });
    }
    Ok(path.to_string())
}

/// SFTP subsystem shared by small operations in the session loop.
pub type SharedSftpSession = Arc<AsyncMutex<Option<Arc<SftpSession>>>>;

async fn open_sftp_session_with_config<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    config: russh_sftp::client::Config,
) -> Result<Arc<SftpSession>, String> {
    let sftp_channel = session.channel_open_session().await.map_err(|e| {
        trf!(
            "SFTP 通道打开失败：{e}",
            "SFTP: failed to open the channel: {e}"
        )
    })?;
    sftp_channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| {
            trf!(
                "SFTP 子系统请求失败：{e}",
                "SFTP: subsystem request failed: {e}"
            )
        })?;
    let sftp = SftpSession::new_with_config(sftp_channel.into_stream(), config)
        .await
        .map_err(|e| {
            trf!(
                "SFTP 会话创建失败：{e}",
                "SFTP: failed to create the session: {e}"
            )
        })?;
    Ok(Arc::new(sftp))
}

async fn open_sftp_session<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
) -> Result<Arc<SftpSession>, String> {
    open_sftp_session_with_config(session, russh_sftp::client::Config::default()).await
}

pub async fn ensure_sftp_session<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
) -> Result<Arc<SftpSession>, String> {
    let mut guard = shared.lock().await;
    if let Some(existing) = guard.as_ref() {
        return Ok(Arc::clone(existing));
    }
    let sftp = open_sftp_session(session).await?;
    *guard = Some(Arc::clone(&sftp));
    Ok(sftp)
}

async fn open_transfer_sftp_session<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
) -> Result<Arc<SftpSession>, String> {
    // russh channel creation uses the same connection-wide request path as
    // other session operations. Serialize only channel setup; each transfer
    // keeps its own SFTP protocol state once initialization completes.
    let _guard = shared.lock().await;
    // Independent channels can transfer concurrently; keep each channel's
    // write acknowledgements ordered to avoid russh-sftp response races.
    open_sftp_session_with_config(
        session,
        russh_sftp::client::Config {
            max_concurrent_writes: 1,
            ..Default::default()
        },
    )
    .await
}

/// Drops the shared session after an operation failed on it, so the next
/// operation opens a fresh SFTP channel instead of reusing a broken one.
async fn drop_shared_sftp_session(shared: &SharedSftpSession) {
    *shared.lock().await = None;
}

/// Encodes one SSH string (u32 length + bytes) for an extended request body.
fn encode_ssh_string(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + value.len());
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
    out
}

/// Tries `posix-rename@openssh.com` on a dedicated channel: unlike a plain
/// SSH_FXP_RENAME it atomically replaces an existing target, closing the
/// "target deleted, replacement not yet in place" window of the two-step
/// overwrite. Returns `Ok(true)` when the rename succeeded, `Ok(false)` when
/// the server does not support the extension (the caller falls back), and
/// `Err` only for setup failures that make the request meaningless.
async fn try_posix_rename<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    old_path: &str,
    new_path: &str,
) -> Result<bool, String> {
    use russh_sftp::client::rawsession::RawSftpSession;
    use russh_sftp::protocol::{Packet, StatusCode};

    let channel = session.channel_open_session().await.map_err(|e| {
        trf!(
            "SFTP 通道打开失败：{e}",
            "SFTP: failed to open the channel: {e}"
        )
    })?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| {
        trf!(
            "SFTP 子系统请求失败：{e}",
            "SFTP: subsystem request failed: {e}"
        )
    })?;
    let raw = RawSftpSession::new(channel.into_stream());
    if raw.init().await.is_err() {
        return Ok(false);
    }
    let mut data = encode_ssh_string(old_path);
    data.extend(encode_ssh_string(new_path));
    Ok(matches!(
        raw.extended("posix-rename@openssh.com", data).await,
        Ok(Packet::Status(status)) if status.status_code == StatusCode::Ok
    ))
}

/// Everything a spawned SFTP task needs to emit session-scoped events.
pub struct SftpTaskCtx<R: Runtime = tauri::Wry> {
    pub app: AppHandle<R>,
    pub window_label: String,
    pub session_id: String,
    /// Identifies this transfer in progress events so the frontend can cancel
    /// a specific transfer instead of whichever one started most recently.
    pub transfer_id: String,
}

// Manual impl: the derived one would require `R: Clone`, and then
// `ctx.clone()` inside a spawned task would silently clone the reference.
impl<R: Runtime> Clone for SftpTaskCtx<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            window_label: self.window_label.clone(),
            session_id: self.session_id.clone(),
            transfer_id: self.transfer_id.clone(),
        }
    }
}

impl<R: Runtime> SftpTaskCtx<R> {
    fn emit_progress(&self, transferred: u64, total: u64) {
        emit_session_event(
            &self.app,
            &self.window_label,
            &self.session_id,
            "sftp-progress",
            None,
            Some(
                serde_json::json!({
                    "transferId": self.transfer_id,
                    "transferred": transferred,
                    "total": total,
                })
                .to_string(),
            ),
            None,
        );
    }
}

/// Progress events cross IPC into the webview; emit at most every 100ms plus
/// once for the final value instead of once per 64KiB chunk.
const SFTP_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub async fn sftp_list_entries<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    path: String,
) -> Result<Vec<SftpEntryValue>, String> {
    let sftp = ensure_sftp_session(session, shared).await?;
    let result = async {
        let effective_path = resolve_sftp_path(&sftp, &path).await?;
        let mut entries = Vec::new();
        let read_dir = sftp.read_dir(&effective_path).await.map_err(|e| {
            trf!(
                "SFTP 列目录失败：{e}",
                "SFTP: failed to list the directory: {e}"
            )
        })?;
        for entry in read_dir {
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
            entries.push(SftpEntryValue {
                name,
                long_name,
                is_dir,
                is_file,
                is_symlink,
                size,
                modified_at,
                permissions,
            });
        }
        Ok::<Vec<SftpEntryValue>, String>(entries)
    }
    .await;
    if result.is_err() {
        drop_shared_sftp_session(shared).await;
    }
    result
}

/// Suffix for the remote temp file an upload writes into before the atomic
/// rename to the final target. Without it, a canceled or failed upload would
/// leave a truncated file at the destination the UI already confirmed
/// overwriting.
fn upload_temp_path(remote_path: &str, transfer_id: &str) -> String {
    format!("{remote_path}.ecpart-{transfer_id}")
}

pub async fn sftp_upload_file<R: Runtime>(
    ctx: &SftpTaskCtx<R>,
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    local_path: String,
    remote_path: String,
    cancel: &AtomicBool,
    remote_temp_slot: &AsyncMutex<Option<String>>,
) -> Result<SftpTransferOutcome, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let sftp = open_transfer_sftp_session(session, shared).await?;
    let mut remote_temp_for_cleanup: Option<String> = None;
    let result = async {
        let remote_path = resolve_sftp_path(&sftp, &remote_path).await?;
        let mut local = tokio::fs::File::open(&local_path).await.map_err(|e| {
            trf!(
                "读取本地文件失败：{e}",
                "Failed to read the local file: {e}"
            )
        })?;
        let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);
        let remote_temp = upload_temp_path(&remote_path, &ctx.transfer_id);
        *remote_temp_slot.lock().await = Some(remote_temp.clone());
        remote_temp_for_cleanup = Some(remote_temp.clone());
        let mut remote = sftp.create(&remote_temp).await.map_err(|e| {
            trf!(
                "创建远端临时文件失败：{e}",
                "Failed to create the remote temp file: {e}"
            )
        })?;
        ctx.emit_progress(0, total);
        let mut buf = vec![0_u8; 64 * 1024];
        let mut transferred: u64 = 0;
        let mut last_progress = tokio::time::Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(trf!("SFTP 传输已取消", "The SFTP transfer was canceled"));
            }
            let n = local.read(&mut buf).await.map_err(|e| {
                trf!(
                    "读取本地文件失败：{e}",
                    "Failed to read the local file: {e}"
                )
            })?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| trf!("SFTP 上传失败：{e}", "SFTP upload failed: {e}"))?;
            transferred += n as u64;
            if last_progress.elapsed() >= SFTP_PROGRESS_INTERVAL {
                ctx.emit_progress(transferred, total);
                last_progress = tokio::time::Instant::now();
            }
        }
        ctx.emit_progress(transferred, total);
        remote
            .flush()
            .await
            .map_err(|e| trf!("SFTP 刷新失败：{e}", "SFTP flush failed: {e}"))?;
        remote
            .shutdown()
            .await
            .map_err(|e| trf!("SFTP 关闭失败：{e}", "SFTP close failed: {e}"))?;
        // A cancel landing between the last byte and the promotion must not
        // publish the file anyway; the temp cleanup below removes it.
        if cancel.load(Ordering::Relaxed) {
            return Err(trf!("SFTP 传输已取消", "The SFTP transfer was canceled"));
        }
        // Promote the complete temp file. A plain SFTP rename fails when the
        // target exists on most servers, so for the overwrite case the UI
        // already confirmed: prefer the server's atomic posix-rename, and fall
        // back to remove-then-rename when it is unavailable.
        if let Err(rename_error) = sftp.rename(&remote_temp, &remote_path).await {
            let target_exists = sftp.metadata(&remote_path).await.is_ok();
            if !target_exists {
                return Err(trf!(
                    "提交上传失败：{rename_error}",
                    "Failed to commit the upload: {rename_error}"
                ));
            }
            match try_posix_rename(session, &remote_temp, &remote_path).await {
                Ok(true) => {}
                // Extension unsupported or refused: fall back to the two-step
                // overwrite. If the fallback itself fails the target is gone,
                // but the temp file is cleaned up below either way.
                Ok(false) | Err(_) => {
                    sftp.remove_file(&remote_path).await.map_err(|e| {
                        trf!(
                            "覆盖远端文件失败：{e}",
                            "Failed to overwrite the remote file: {e}"
                        )
                    })?;
                    sftp.rename(&remote_temp, &remote_path).await.map_err(|e| {
                        trf!("提交上传失败：{e}", "Failed to commit the upload: {e}")
                    })?;
                }
            }
        }
        remote_temp_for_cleanup = None;
        Ok((transferred, total))
    }
    .await;
    match result {
        Ok((transferred, total)) => Ok(SftpTransferOutcome {
            transfer_id: ctx.transfer_id.clone(),
            operation: "upload",
            status: "completed",
            transferred,
            total,
        }),
        Err(error) => {
            if let Some(temp) = remote_temp_for_cleanup {
                // Best effort: an aborted half-written temp file must not
                // linger on the remote side.
                let _ = sftp.remove_file(&temp).await;
            }
            if cancel.load(Ordering::Relaxed) {
                Ok(SftpTransferOutcome {
                    transfer_id: ctx.transfer_id.clone(),
                    operation: "upload",
                    status: "canceled",
                    transferred: 0,
                    total: 0,
                })
            } else {
                Err(error)
            }
        }
    }
}

/// Downloads use several SFTP handles reading distinct ranges concurrently:
/// russh-sftp reads are strictly sequential per handle (every READ awaits its
/// response), so a single handle is round-trip-bound on high-latency links,
/// while writes already pipeline internally. Four handles is conservative —
/// most servers allow far more open files per session.
const SFTP_DOWNLOAD_CONCURRENCY: usize = 4;
/// Ranges below this size gain nothing from parallelism; small files stay on
/// a single handle.
const SFTP_DOWNLOAD_MIN_RANGE: u64 = 1024 * 1024;

pub async fn sftp_download_file<R: Runtime>(
    ctx: &SftpTaskCtx<R>,
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    remote_path: String,
    local_path: String,
    cancel: &Arc<AtomicBool>,
) -> Result<SftpTransferOutcome, String> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    let sftp = open_transfer_sftp_session(session, shared).await?;
    let remote_path = resolve_sftp_path(&sftp, &remote_path).await?;
    let total = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| {
            trf!(
                "SFTP 获取文件信息失败：{e}",
                "SFTP: failed to stat the file: {e}"
            )
        })?
        .size
        .unwrap_or(0);
    let part_path = format!("{local_path}.part");
    let transferred = Arc::new(AtomicU64::new(0));
    let result = async {
        let local = tokio::fs::File::create(&part_path).await.map_err(|e| {
            trf!(
                "创建本地临时文件失败：{e}",
                "Failed to create the local temp file: {e}"
            )
        })?;
        if total > 0 {
            // Pre-size the file so range workers can seek and write freely.
            local
                .set_len(total)
                .await
                .map_err(|e| trf!("创建本地临时文件失败：{e}", "Failed to create the local temp file: {e}"))?;
        }
        let local = Arc::new(AsyncMutex::new(local));
        ctx.emit_progress(0, total);

        let workers = if total == 0 {
            0
        } else {
            let max_workers = total.div_ceil(SFTP_DOWNLOAD_MIN_RANGE) as usize;
            usize::min(SFTP_DOWNLOAD_CONCURRENCY, usize::max(max_workers, 1))
        };
        let chunk = if workers > 0 {
            total.div_ceil(workers as u64)
        } else {
            0
        };

        // Open every range handle up front, before the progress ticker runs:
        // an open failure here must not leave a ticker emitting stale progress
        // for a transfer that never started. Dropped handles close lazily via
        // `close_nowait`, so a mid-sequence failure cleans itself up.
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(sftp.open(&remote_path).await.map_err(|e| {
                trf!(
                    "打开远端文件失败：{e}",
                    "Failed to open the remote file: {e}"
                )
            })?);
        }

        // Emits throttled progress from the shared counter while workers run.
        let ticker = if workers == 0 {
            None
        } else {
            Some(tokio::spawn({
                let ctx = ctx.clone();
                let transferred = Arc::clone(&transferred);
                let cancel = Arc::clone(cancel);
                async move {
                    loop {
                        tokio::time::sleep(SFTP_PROGRESS_INTERVAL).await;
                        if cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        ctx.emit_progress(transferred.load(Ordering::Relaxed), total);
                    }
                }
            }))
        };

        let mut join_set = tokio::task::JoinSet::new();
        for (worker, mut remote) in handles.into_iter().enumerate() {
            let start = worker as u64 * chunk;
            let end = u64::min(total, start + chunk);
            if start >= end {
                continue;
            }
            let local = Arc::clone(&local);
            let transferred = Arc::clone(&transferred);
            let cancel = Arc::clone(cancel);
            join_set.spawn(async move {
                use tokio::io::AsyncReadExt;
                remote
                    .seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|e| trf!("SFTP 下载失败：{e}", "SFTP download failed: {e}"))?;
                let mut buf = vec![0_u8; 64 * 1024];
                let mut pos = start;
                while pos < end {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(trf!("SFTP 传输已取消", "The SFTP transfer was canceled"));
                    }
                    let want = usize::min(buf.len(), (end - pos) as usize);
                    let n = remote
                        .read(&mut buf[..want])
                        .await
                        .map_err(|e| trf!("SFTP 下载失败：{e}", "SFTP download failed: {e}"))?;
                    if n == 0 {
                        return Err(trf!(
                            "SFTP 下载意外中断：远端文件比预期短",
                            "The SFTP download ended unexpectedly: the remote file is shorter than expected"
                        ));
                    }
                    // Local disk writes are serialized; the network is the
                    // bottleneck, so a single shared file handle is fine.
                    let mut local = local.lock().await;
                    local
                        .seek(std::io::SeekFrom::Start(pos))
                        .await
                        .map_err(|e| trf!("写入本地文件失败：{e}", "Failed to write the local file: {e}"))?;
                    local.write_all(&buf[..n]).await.map_err(|e| {
                        trf!(
                            "写入本地文件失败：{e}",
                            "Failed to write the local file: {e}"
                        )
                    })?;
                    drop(local);
                    pos += n as u64;
                    transferred.fetch_add(n as u64, Ordering::Relaxed);
                }
                let _ = remote.shutdown().await;
                Ok::<(), String>(())
            });
        }

        let mut first_error: Option<String> = None;
        while let Some(joined) = join_set.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                    join_set.abort_all();
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(trf!(
                            "SFTP 下载任务失败：{error}",
                            "SFTP download task failed: {error}"
                        ));
                    }
                    join_set.abort_all();
                }
            }
        }
        if let Some(ticker) = ticker {
            ticker.abort();
        }
        if let Some(error) = first_error {
            return Err(error);
        }

        ctx.emit_progress(transferred.load(Ordering::Relaxed), total);
        {
            let mut guard = local.lock().await;
            guard.flush().await.map_err(|e| {
                trf!(
                    "刷新本地文件失败：{e}",
                    "Failed to flush the local file: {e}"
                )
            })?;
        }
        // Every range worker has been reaped above, so this is the last
        // reference; dropping it closes the file before the rename below
        // (required on Windows, where renaming an open file fails).
        drop(local);
        if let Err(error) = tokio::fs::rename(&part_path, &local_path).await {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(trf!(
                "完成下载重命名失败：{error}",
                "Failed to rename the completed download: {error}"
            ));
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(SftpTransferOutcome {
            transfer_id: ctx.transfer_id.clone(),
            operation: "download",
            status: "completed",
            transferred: transferred.load(Ordering::Relaxed),
            total,
        }),
        Err(error) => {
            // Failure, cancellation, and session death all remove the temp
            // file: nothing below this line resumes from it, so a leftover
            // `.part` would only invite mistaking it for a complete file.
            let _ = tokio::fs::remove_file(&part_path).await;
            if cancel.load(Ordering::Relaxed) {
                Ok(SftpTransferOutcome {
                    transfer_id: ctx.transfer_id.clone(),
                    operation: "download",
                    status: "canceled",
                    transferred: transferred.load(Ordering::Relaxed),
                    total,
                })
            } else {
                Err(error)
            }
        }
    }
}

pub async fn sftp_delete_path<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    path: String,
) -> Result<(), String> {
    let sftp = ensure_sftp_session(session, shared).await?;
    let result = async {
        let path = resolve_sftp_path(&sftp, &path).await?;
        let metadata = sftp.metadata(&path).await.map_err(|e| {
            trf!(
                "SFTP 获取文件信息失败：{e}",
                "SFTP: failed to stat the file: {e}"
            )
        })?;
        if metadata.is_dir() {
            sftp.remove_dir(&path).await.map_err(|e| {
                trf!(
                    "SFTP 删除目录失败：{e}",
                    "SFTP: failed to remove the directory: {e}"
                )
            })?;
        } else {
            sftp.remove_file(&path).await.map_err(|e| {
                trf!(
                    "SFTP 删除文件失败：{e}",
                    "SFTP: failed to remove the file: {e}"
                )
            })?;
        }
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        drop_shared_sftp_session(shared).await;
    }
    result
}

pub async fn sftp_rename_path<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let sftp = ensure_sftp_session(session, shared).await?;
    let result = async {
        let old_path = resolve_sftp_path(&sftp, &old_path).await?;
        let new_path = resolve_sftp_path(&sftp, &new_path).await?;
        sftp.rename(&old_path, &new_path)
            .await
            .map_err(|e| trf!("SFTP 重命名失败：{e}", "SFTP rename failed: {e}"))?;
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        drop_shared_sftp_session(shared).await;
    }
    result
}

pub async fn sftp_mkdir_path<R: Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
    shared: &SharedSftpSession,
    path: String,
) -> Result<(), String> {
    let sftp = ensure_sftp_session(session, shared).await?;
    let result = async {
        let path = resolve_sftp_path(&sftp, &path).await?;
        sftp.create_dir(&path).await.map_err(|e| {
            trf!(
                "SFTP 创建目录失败：{e}",
                "SFTP: failed to create the directory: {e}"
            )
        })?;
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        drop_shared_sftp_session(shared).await;
    }
    result
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntryValue>, String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpList { path, response }
    })
    .await
}

/// Records a user-picked directory as an allowed root for this session's
/// SFTP local paths (SSH-P2-09). The renderer calls this with the parent
/// directory of every path it obtained from a native dialog.
#[tauri::command]
pub fn sftp_register_local_root(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    root_path: String,
) -> Result<(), String> {
    state.register_sftp_local_root(&window, &session_id, &root_path)
}

#[tauri::command]
pub async fn sftp_upload<R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow<R>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<SftpTransferOutcome, String> {
    // SSH-P2-09: the renderer may only read files under a directory the user
    // picked in a native dialog this session.
    let allowed = state.ensure_sftp_local_path_allowed(&window, &session_id, &local_path)?;
    if !allowed.is_file() {
        return Err(trf!(
            "本地路径不是文件：{local_path}",
            "The local path is not a file: {local_path}"
        ));
    }
    let local_path = allowed.into_os_string().into_string().map_err(|_| {
        trf!(
            "本地路径包含无效文本",
            "The local path contains invalid text"
        )
    })?;
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpUpload {
            local_path,
            remote_path,
            response,
        }
    })
    .await
}

#[tauri::command]
pub async fn sftp_download<R: Runtime>(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow<R>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<SftpTransferOutcome, String> {
    // SSH-P2-09: the renderer may only write files under a directory the user
    // picked in a native dialog this session.
    let allowed = state.ensure_sftp_local_path_allowed(&window, &session_id, &local_path)?;
    if !allowed
        .parent()
        .map(|parent| parent.is_dir())
        .unwrap_or(false)
    {
        return Err(trf!(
            "本地目录不存在：{local_path}",
            "The local directory does not exist: {local_path}"
        ));
    }
    let local_path = allowed.into_os_string().into_string().map_err(|_| {
        trf!(
            "本地路径包含无效文本",
            "The local path contains invalid text"
        )
    })?;
    // The worker and cancellation cleanup derive this exact path from the
    // canonical destination. Never follow an existing .part symlink.
    let part_path = format!("{local_path}.part");
    state.ensure_sftp_local_path_allowed(&window, &session_id, &part_path)?;
    if std::fs::symlink_metadata(&part_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(trf!(
            "本地下载临时文件不能是符号链接",
            "The local download temp file cannot be a symbolic link"
        ));
    }
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpDownload {
            remote_path,
            local_path,
            response,
        }
    })
    .await
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpDelete { path, response }
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpRename {
            old_path,
            new_path,
            response,
        }
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    path: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::SftpMkdir { path, response }
    })
    .await
}

/// Aborts one SFTP upload/download for this session. Without a transfer id,
/// the most recently started transfer is canceled. The aborted transfer's own
/// command resolves with a canceled outcome; this command only reports that
/// the cancel request was delivered.
#[tauri::command]
pub async fn sftp_cancel(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    transfer_id: Option<String>,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::CancelSftp {
            transfer_id,
            response,
        }
    })
    .await
}
