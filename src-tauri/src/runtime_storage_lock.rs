//! Cross-process directory lock shared with the Node sidecars' proper-lockfile.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use crate::trf;

const LOCK_SUFFIX: &str = ".lock";
const STALE_AFTER: Duration = Duration::from_secs(30);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(10);
const RETRY_EVERY: Duration = Duration::from_millis(25);
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) struct RuntimeStorageFileLock {
    directory: PathBuf,
    stopped: Arc<AtomicBool>,
    compromised: Arc<AtomicBool>,
    expected_mtime: Arc<std::sync::Mutex<SystemTime>>,
    heartbeat: Option<JoinHandle<()>>,
}

impl RuntimeStorageFileLock {
    pub(crate) fn acquire(storage_path: &Path) -> Result<Self, String> {
        let parent = storage_path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|error| {
            trf!(
                "无法创建本地存储目录：{error}",
                "Failed to create the local storage directory: {error}"
            )
        })?;
        // A lock must not create an empty primary that shadows a legacy backup.
        let canonical_path = fs::canonicalize(storage_path)
            .or_else(|error| {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error);
                }
                Ok(fs::canonicalize(parent)?.join(storage_path.file_name().unwrap_or_default()))
            })
            .map_err(|error| {
                trf!(
                    "无法解析本地存储锁路径：{error}",
                    "Failed to resolve the local storage lock path: {error}"
                )
            })?;
        let directory = PathBuf::from(format!("{}{LOCK_SUFFIX}", canonical_path.display()));
        let started = Instant::now();
        loop {
            match fs::create_dir(&directory) {
                Ok(()) => return Self::start_heartbeat(directory),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if reclaim_if_stale(&directory)? {
                        continue;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                // Windows may report a delete-pending directory as access
                // denied for one retry while the other process releases it.
                Err(error)
                    if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied => {}
                Err(error) => {
                    return Err(trf!(
                        "无法锁定本地存储：{error}",
                        "Failed to lock local storage: {error}"
                    ));
                }
            }
            if started.elapsed() >= ACQUIRE_TIMEOUT {
                return Err(trf!(
                    "等待本地存储锁超时",
                    "Timed out waiting for the local storage lock"
                ));
            }
            thread::sleep(RETRY_EVERY);
        }
    }

    fn start_heartbeat(directory: PathBuf) -> Result<Self, String> {
        let initial_mtime = modified_time(&directory).map_err(|error| {
            trf!(
                "无法初始化本地存储锁：{error}",
                "Failed to initialize the local storage lock: {error}"
            )
        })?;
        let expected_mtime = Arc::new(std::sync::Mutex::new(initial_mtime));
        let stopped = Arc::new(AtomicBool::new(false));
        let compromised = Arc::new(AtomicBool::new(false));

        let thread_directory = directory.clone();
        let thread_stopped = Arc::clone(&stopped);
        let thread_compromised = Arc::clone(&compromised);
        let thread_expected = Arc::clone(&expected_mtime);
        let heartbeat = thread::spawn(move || loop {
            thread::park_timeout(HEARTBEAT_EVERY);
            if thread_stopped.load(Ordering::Acquire) {
                break;
            }
            let mut expected = thread_expected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if modified_time(&thread_directory).ok() != Some(*expected)
                || filetime::set_file_mtime(&thread_directory, filetime::FileTime::now()).is_err()
            {
                thread_compromised.store(true, Ordering::Release);
                break;
            }
            match modified_time(&thread_directory) {
                Ok(next) => {
                    *expected = next;
                }
                Err(_) => {
                    thread_compromised.store(true, Ordering::Release);
                    break;
                }
            }
        });

        Ok(Self {
            directory,
            stopped,
            compromised,
            expected_mtime,
            heartbeat: Some(heartbeat),
        })
    }

    pub(crate) fn ensure_healthy(&self) -> Result<(), String> {
        let expected = self
            .expected_mtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.compromised.load(Ordering::Acquire)
            || modified_time(&self.directory).ok() != Some(*expected)
        {
            return Err(trf!(
                "本地存储锁已失效；请重试操作",
                "The local storage lock was lost; retry the operation"
            ));
        }
        Ok(())
    }
}

impl Drop for RuntimeStorageFileLock {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.thread().unpark();
            let _ = heartbeat.join();
        }

        if self.compromised.load(Ordering::Acquire) {
            return;
        }
        let expected = *self
            .expected_mtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if modified_time(&self.directory).ok() == Some(expected) {
            let _ = fs::remove_dir(&self.directory);
        }
    }
}

fn modified_time(path: &Path) -> std::io::Result<SystemTime> {
    fs::metadata(path)?.modified()
}

fn reclaim_if_stale(directory: &Path) -> Result<bool, String> {
    let first = match modified_time(directory) {
        Ok(time) => time,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok(false)
        }
        Err(error) => {
            return Err(trf!(
                "无法检查本地存储锁：{error}",
                "Failed to inspect the local storage lock: {error}"
            ));
        }
    };
    let age = SystemTime::now().duration_since(first).unwrap_or_default();
    if age <= STALE_AFTER {
        return Ok(false);
    }

    // Recheck before reclaiming, as proper-lockfile does, so a fresh heartbeat
    // observed between the initial stat and removal keeps ownership intact.
    if modified_time(directory).ok() != Some(first) {
        return Ok(false);
    }
    match fs::remove_dir(directory) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(trf!(
            "无法回收失效的本地存储锁：{error}",
            "Failed to reclaim a stale local storage lock: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;

    #[test]
    fn lock_blocks_a_second_thread_until_the_first_releases_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let first = RuntimeStorageFileLock::acquire(&path).unwrap();
        let (sent, received) = mpsc::channel();
        let path_for_thread = path.clone();
        let thread = thread::spawn(move || {
            let _second = RuntimeStorageFileLock::acquire(&path_for_thread).unwrap();
            sent.send(()).unwrap();
        });

        assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first);
        received.recv_timeout(Duration::from_secs(2)).unwrap();
        thread.join().unwrap();
    }

    #[test]
    fn lock_reclaims_an_abandoned_proper_lockfile_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let lock_dir = PathBuf::from(format!("{}{LOCK_SUFFIX}", path.display()));
        fs::create_dir(&lock_dir).unwrap();
        let old = filetime::FileTime::from_system_time(
            SystemTime::now() - STALE_AFTER - Duration::from_secs(1),
        );
        filetime::set_file_mtime(&lock_dir, old).unwrap();

        let _lock = RuntimeStorageFileLock::acquire(&path).unwrap();
        assert!(lock_dir.exists());
    }

    #[test]
    fn locking_a_missing_primary_does_not_hide_its_legacy_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        fs::write(
            dir.path().join("runtime-storage.json.bak"),
            r#"{"key":"backup"}"#,
        )
        .unwrap();
        let file_lock = RuntimeStorageFileLock::acquire(&path).unwrap();
        assert!(!path.exists());
        let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("key").unwrap().as_deref(), Some("backup"));
        file_lock.ensure_healthy().unwrap();
    }

    #[test]
    fn rust_and_proper_lockfile_block_each_other_across_processes() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let js_path = serde_json::to_string(&path.to_string_lossy()).unwrap();
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

        let rust_lock = RuntimeStorageFileLock::acquire(&path).unwrap();
        let attempt = format!(
            "const lockfile=require('proper-lockfile');lockfile.lock({js_path},{{retries:0,realpath:false}}).then((release)=>release()).catch((e)=>{{console.error(e.code);process.exitCode=2}})"
        );
        let blocked = Command::new("node")
            .args(["-e", &attempt])
            .current_dir(workspace)
            .output()
            .unwrap();
        assert!(
            !blocked.status.success(),
            "the Node sidecar acquired a lock already held by Tauri"
        );
        assert!(
            String::from_utf8_lossy(&blocked.stderr).contains("ELOCKED"),
            "expected an ELOCKED error, received: {}",
            String::from_utf8_lossy(&blocked.stderr)
        );
        drop(rust_lock);

        let hold = format!(
            "const lockfile=require('proper-lockfile');lockfile.lock({js_path},{{retries:0,realpath:false}}).then((release)=>{{console.log('locked');setTimeout(()=>release().then(()=>{{process.exitCode=0}}),300)}}).catch((e)=>{{console.error(e.code);process.exitCode=2}})"
        );
        let mut child = Command::new("node")
            .args(["-e", &hold])
            .current_dir(workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.trim() != "locked" {
            let mut stderr = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            let status = child.wait().unwrap();
            panic!("Node failed before acquiring its lock ({status}): {stderr}");
        }

        let wait_started = Instant::now();
        let rust_lock = RuntimeStorageFileLock::acquire(&path).unwrap();
        assert!(wait_started.elapsed() >= Duration::from_millis(200));
        rust_lock.ensure_healthy().unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn node_and_rust_share_records_and_do_not_lose_concurrent_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        {
            let _guard = RuntimeStorageFileLock::acquire(&path).unwrap();
            let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
            store.set("counter", "0").unwrap();
            store.set("from-rust", "native").unwrap();
        }
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let js_path = serde_json::to_string(&path.to_string_lossy()).unwrap();
        let script = format!(
            r#"import assert from 'node:assert/strict';
import {{ createFileLocalStorage }} from './tools/easy-console/local-data-store.ts';
const store=createFileLocalStorage({js_path});
assert.equal(await store.get('from-rust'),'native');
console.log('ready');
for(let index=0;index<20;index++) {{
  await store.update('counter',async raw=>{{await new Promise(resolve=>setTimeout(resolve,2));return String(Number(raw)+1)}});
}}
await store.set('from-node','sidecar');
await store.remove('from-rust');"#
        );
        let mut child = Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "-e", &script])
            .current_dir(workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node and npm dependencies are required for the storage interoperability test");
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.trim() != "ready" {
            let output = child.wait_with_output().unwrap();
            panic!(
                "Node storage worker did not start: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        for _ in 0..20 {
            let guard = RuntimeStorageFileLock::acquire(&path).unwrap();
            let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
            let current = store.get("counter").unwrap().unwrap();
            let next = (current.parse::<u32>().unwrap() + 1).to_string();
            assert!(
                store
                    .compare_and_swap("counter", Some(&current), Some(&next))
                    .unwrap()
                    .0
            );
            guard.ensure_healthy().unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Node storage worker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let _guard = RuntimeStorageFileLock::acquire(&path).unwrap();
        let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
        assert_eq!(store.get("counter").unwrap().as_deref(), Some("40"));
        assert_eq!(store.get("from-node").unwrap().as_deref(), Some("sidecar"));
        assert_eq!(store.get("from-rust").unwrap(), None);
    }
}
