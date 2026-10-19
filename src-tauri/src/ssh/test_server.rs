//! A local russh SSH server for integration tests: password and public-key
//! auth, a shell that emits a one-line banner, an echo for PTY data, and a
//! filesystem-backed SFTP rooted at a temp directory. Only compiled for
//! `cargo test`; never part of the shipped app.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::HashAlg;
use russh::keys::PrivateKey;
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    File, FileAttributes, Handle, Name, OpenFlags, Packet, Status, StatusCode, Version,
};
use tokio::sync::Mutex;

pub struct TestSshServer {
    pub username: String,
    pub password: String,
    /// When set, public-key auth succeeds only with this key.
    pub authorized_public_key: Option<russh::keys::ssh_key::PublicKey>,
    /// First line sent to the client after a shell request.
    pub shell_banner: String,
    /// Root directory served over SFTP.
    pub sftp_root: PathBuf,
    /// Artificial delay per SFTP read/write, letting tests cancel transfers
    /// deterministically while they are still in flight.
    pub transfer_delay: Option<Duration>,
    /// When set, the shell channel parks inside the first `data` callback: the
    /// server stops reading, its flow-control window never replenishes, and a
    /// client write blocks — the deterministic stall used by the input-channel
    /// back-pressure test.
    pub stall_shell_input: bool,
    /// When set, the SFTP server answers `posix-rename@openssh.com` extended
    /// requests (atomically replacing an existing target).
    pub support_posix_rename: bool,
    /// Flips when a posix-rename extended request reaches the SFTP server, so
    /// tests can prove the atomic commit path was taken.
    pub posix_rename_seen: Arc<AtomicBool>,
}

impl russh::server::Server for TestSshServer {
    type Handler = TestClientHandler;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        TestClientHandler {
            username: self.username.clone(),
            password: self.password.clone(),
            authorized_public_key: self.authorized_public_key.clone(),
            shell_banner: self.shell_banner.clone(),
            sftp_root: self.sftp_root.clone(),
            transfer_delay: self.transfer_delay,
            stall_shell_input: self.stall_shell_input,
            support_posix_rename: self.support_posix_rename,
            posix_rename_seen: Arc::clone(&self.posix_rename_seen),
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone)]
pub struct TestClientHandler {
    username: String,
    password: String,
    authorized_public_key: Option<russh::keys::ssh_key::PublicKey>,
    shell_banner: String,
    sftp_root: PathBuf,
    transfer_delay: Option<Duration>,
    stall_shell_input: bool,
    support_posix_rename: bool,
    posix_rename_seen: Arc<AtomicBool>,
    /// Channels opened per connection; the SFTP subsystem request turns its
    /// channel into a byte stream for the SFTP server.
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl TestClientHandler {
    async fn take_channel(&mut self, channel_id: ChannelId) -> Channel<Msg> {
        self.channels.lock().await.remove(&channel_id).unwrap()
    }
}

impl russh::server::Handler for TestClientHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == self.username && password == self.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        // Compare fingerprints (not derived equality) so a comment difference
        // between the authorized line and the loaded key cannot break auth.
        let matches = match &self.authorized_public_key {
            Some(authorized) => {
                user == self.username
                    && authorized.fingerprint(HashAlg::Sha256).to_string()
                        == public_key.fingerprint(HashAlg::Sha256).to_string()
            }
            None => false,
        };
        if matches {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        Ok(true)
    }

    /// Accepts direct-tcpip channels (tunneled connections) and holds them
    /// open without reading. The tunnel stays alive until the channel or the
    /// whole session goes away, so tests can assert that aborting a port
    /// forward tears its tunneled connections down.
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        Ok(true)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, self.shell_banner.clone())?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.stall_shell_input {
            // Park the connection's read loop: no further reads means no
            // window updates, so a client writing to this channel blocks once
            // its send window is exhausted.
            std::future::pending::<()>().await;
        }
        // Echo: lets a test assert the input path end to end.
        session.data(channel, data.to_vec())?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.take_channel(channel_id).await;
            session.channel_success(channel_id)?;
            let handler = TestSftpHandler::new(
                self.sftp_root.clone(),
                self.transfer_delay,
                self.support_posix_rename,
                Arc::clone(&self.posix_rename_seen),
            );
            russh_sftp::server::run(channel.into_stream(), handler).await;
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

/// Decodes one SSH string (u32 big-endian length + bytes) from an extended
/// request body, returning the value and the unconsumed remainder.
fn decode_ssh_string(data: &[u8]) -> Option<(String, &[u8])> {
    if data.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    if data.len() < 4 + len {
        return None;
    }
    Some((
        String::from_utf8_lossy(&data[4..4 + len]).into_owned(),
        &data[4 + len..],
    ))
}

/// A filesystem-backed SFTP server rooted at a fixed directory. Paths are
/// mapped: `/` and `~` resolve to the root; everything else joins onto it.
struct TestSftpHandler {
    root: PathBuf,
    handles: HashMap<String, SftpHandle>,
    next_handle: u64,
    dir_read_done: bool,
    transfer_delay: Option<Duration>,
    support_posix_rename: bool,
    posix_rename_seen: Arc<AtomicBool>,
}

enum SftpHandle {
    File(std::fs::File),
    Dir(PathBuf),
}

impl TestSftpHandler {
    fn new(
        root: PathBuf,
        transfer_delay: Option<Duration>,
        support_posix_rename: bool,
        posix_rename_seen: Arc<AtomicBool>,
    ) -> Self {
        Self {
            root,
            handles: HashMap::new(),
            next_handle: 0,
            dir_read_done: false,
            transfer_delay,
            support_posix_rename,
            posix_rename_seen,
        }
    }

    async fn pace(&self) {
        if let Some(delay) = self.transfer_delay {
            tokio::time::sleep(delay).await;
        }
    }

    fn resolve(&self, path: &str) -> PathBuf {
        let path = path.replace('\\', "/");
        if path == "/" || path == "~" || path == "~/" {
            return self.root.clone();
        }
        let stripped = path
            .strip_prefix("~/")
            .or_else(|| path.strip_prefix('/'))
            .unwrap_or(&path);
        self.root.join(stripped)
    }

    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }

    fn attrs_for(path: &Path) -> FileAttributes {
        let Ok(meta) = std::fs::metadata(path) else {
            return FileAttributes::default();
        };
        FileAttributes {
            size: Some(meta.len()),
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions: None,
            atime: None,
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as u32),
        }
    }
}

impl russh_sftp::server::Handler for TestSftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version {
            version,
            extensions: HashMap::new(),
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = self.resolve(&filename);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::from(pflags)
            .open(&path)
            .map_err(|_| StatusCode::NoSuchFile)?;
        self.next_handle += 1;
        let handle = format!("h{}", self.next_handle);
        self.handles.insert(handle.clone(), SftpHandle::File(file));
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(Self::ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        self.pace().await;
        let Some(SftpHandle::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        let mut buf = vec![0_u8; len as usize];
        let read = file.read(&mut buf).map_err(|_| StatusCode::Failure)?;
        buf.truncate(read);
        Ok(russh_sftp::protocol::Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        self.pace().await;
        let Some(SftpHandle::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        file.write_all(&data).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok(id))
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let resolved = self.resolve(&path);
        std::fs::metadata(&resolved)
            .map(|_| russh_sftp::protocol::Attrs {
                id,
                attrs: Self::attrs_for(&resolved),
            })
            .map_err(|_| StatusCode::NoSuchFile)
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        self.stat(id, path).await
    }

    async fn fstat(
        &mut self,
        _id: u32,
        handle: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let Some(SftpHandle::File(file)) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        let meta = file.metadata().map_err(|_| StatusCode::Failure)?;
        let _ = meta;
        Err(StatusCode::OpUnsupported)
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(Self::ok(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        _handle: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(Self::ok(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let resolved = self.resolve(&path);
        if !resolved.is_dir() {
            return Err(StatusCode::NoSuchFile);
        }
        self.dir_read_done = false;
        self.next_handle += 1;
        let handle = format!("h{}", self.next_handle);
        self.handles
            .insert(handle.clone(), SftpHandle::Dir(resolved));
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(SftpHandle::Dir(path)) = self.handles.get(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        if self.dir_read_done {
            return Err(StatusCode::Eof);
        }
        self.dir_read_done = true;
        let mut files = Vec::new();
        let entries = std::fs::read_dir(path).map_err(|_| StatusCode::NoSuchFile)?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            files.push(File {
                filename: name,
                longname: String::new(),
                attrs: Self::attrs_for(&entry.path()),
            });
        }
        Ok(Name { id, files })
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.resolve(&filename))
            .map(|_| Self::ok(id))
            .map_err(|_| StatusCode::NoSuchFile)
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.resolve(&path))
            .map(|_| Self::ok(id))
            .map_err(|_| StatusCode::Failure)
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.resolve(&path))
            .map(|_| Self::ok(id))
            .map_err(|_| StatusCode::Failure)
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(self.resolve(&path).to_string_lossy())],
        })
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath);
        let to = self.resolve(&newpath);
        if !from.exists() {
            return Err(StatusCode::NoSuchFile);
        }
        // Plain SFTP rename semantics: fail when the target already exists.
        if to.exists() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(&from, &to)
            .map(|_| Self::ok(id))
            .map_err(|_| StatusCode::Failure)
    }

    /// `posix-rename@openssh.com`: atomically replace the target even when it
    /// exists. Only answered when the server is configured to support it.
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<Packet, Self::Error> {
        if request != "posix-rename@openssh.com" || !self.support_posix_rename {
            return Err(StatusCode::OpUnsupported);
        }
        let (oldpath, rest) = decode_ssh_string(&data).ok_or(StatusCode::Failure)?;
        let (newpath, _rest) = decode_ssh_string(rest).ok_or(StatusCode::Failure)?;
        self.posix_rename_seen.store(true, Ordering::Relaxed);
        std::fs::rename(self.resolve(&oldpath), self.resolve(&newpath))
            .map(|_| Packet::Status(Self::ok(id)))
            .map_err(|_| StatusCode::Failure)
    }

    async fn readlink(&mut self, _id: u32, _path: String) -> Result<Name, Self::Error> {
        Err(StatusCode::OpUnsupported)
    }

    async fn symlink(
        &mut self,
        _id: u32,
        _path: String,
        _target: String,
    ) -> Result<Status, Self::Error> {
        Err(StatusCode::OpUnsupported)
    }
}

/// Generates an ed25519 key pair via `ssh-keygen` (same tool the VS Code
/// integration uses) and returns the private key plus the OpenSSH public key
/// line.
pub fn generate_key_pair(dir: &Path, name: &str, passphrase: &str) -> (PathBuf, String) {
    let private = dir.join(name);
    // ssh-keygen appends ".pub" to the private key path verbatim.
    let public = PathBuf::from(format!("{}.pub", private.display()));
    let _ = std::fs::remove_file(&private);
    let _ = std::fs::remove_file(&public);
    let status = std::process::Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-N",
            passphrase,
            "-C",
            "easy-console-test",
            "-q",
            "-f",
        ])
        .arg(&private)
        .status()
        .expect("ssh-keygen must be available to run SSH integration tests");
    assert!(status.success(), "ssh-keygen failed for {name}");
    let public_text = std::fs::read_to_string(&public).unwrap();
    (private, public_text.trim().to_string())
}

/// Loads a private key file for the server host key.
pub fn load_host_key(path: &Path) -> PrivateKey {
    russh::keys::load_secret_key(path.to_string_lossy().as_ref(), None)
        .expect("test host key must load")
}
