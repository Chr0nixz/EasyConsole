//! End-to-end tests for the SSH subsystem against a local russh server
//! (see `test_server.rs`). They cover the paths the phase-0 hardening work
//! touches: authentication, host-key TOFU, PTY output, SFTP transfer
//! contract (temp files, atomic commit, cancellation), and port-forward
//! rule lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::server::Server as _;
use serde::Deserialize;
use tauri::Listener as _;
use tokio::sync::{mpsc, oneshot};

use easy_console_lib::ssh::host_key::persist_known_host;
use easy_console_lib::ssh::port_forward::PortForwardRuleValue;
use easy_console_lib::ssh::session::{
    run_russh_session, SshCommand, SshConnectionRequest, SshSessionState,
};
use easy_console_lib::ssh::sftp::SftpTransferOutcome;
use easy_console_lib::ssh::test_server::{generate_key_pair, load_host_key, TestSshServer};

/// Erases the distinct `impl Future` types so the dispatch `match` unifies.
fn box_test(
    f: impl std::future::Future<Output = ()> + 'static,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
    Box::pin(f)
}

/// Test entry points, run one process per test by `main` below.
const TESTS: &[&str] = &[
    "wrong_password_fails_the_session",
    "correct_password_connects_and_closes_cleanly",
    "large_input_cannot_block_session_control",
    "private_key_auth_accepts_and_rejects_keys",
    "host_key_prompt_confirms_first_connection",
    "changed_host_key_is_rejected",
    "sftp_upload_and_download_round_trip",
    "sftp_cancel_aborts_upload_and_leaves_no_remote_file",
    "sftp_cancel_removes_local_part_file",
    "sftp_overwrite_uses_atomic_posix_rename",
    "port_forward_rules_track_their_lifecycle",
    "port_forward_stop_aborts_tunneled_connections",
    "minimal_two_key_connections",
    "reconnect_after_auth_failure_connects",
    "second_connection_to_the_same_server_connects",
    "cross_window_session_access_is_rejected",
];

/// Mirrors the native `SshSessionEvent` payload for Rust-side assertions.
#[derive(Debug, Deserialize)]
struct TestSessionEvent {
    kind: String,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[allow(dead_code)] // mirrors the native payload even when a test ignores it
    message: Option<String>,
}

/// Safety net only; a healthy run finishes each test in well under a second.
const TEST_TIMEOUT: Duration = Duration::from_secs(60);

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    init_test_logging();
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app must build")
}

/// Prints russh/ssh traffic logs to stderr so stalls are diagnosable.
/// Enabled with EC_TEST_DEBUG=1.
fn init_test_logging() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        if std::env::var("EC_TEST_DEBUG").is_err() {
            return;
        }
        struct StderrLogger;
        impl log::Log for StderrLogger {
            fn enabled(&self, metadata: &log::Metadata) -> bool {
                metadata.level() <= log::Level::Debug
            }
            fn log(&self, record: &log::Record) {
                if self.enabled(record.metadata()) {
                    eprintln!("[log:{:5}] {}", record.level(), record.args());
                }
            }
            fn flush(&self) {}
        }
        let _ = log::set_boxed_logger(Box::new(StderrLogger));
        log::set_max_level(log::LevelFilter::Debug);
    });
}

/// The mock runtime has no app identifier, so `app_data_dir` lands directly in
/// the user's data directory. Host-key tests must start from a clean store and
/// remove their own state afterwards.
fn known_hosts_store(app: &tauri::App<tauri::test::MockRuntime>) -> std::path::PathBuf {
    easy_console_lib::app_data_file(app.handle(), "known-ssh-hosts.json").expect("store path")
}

/// The shared test host key, generated once per process. A per-run UUID file
/// name would make Windows Defender scan a fresh file for every test, which
/// intermittently stalled handshakes for tens of seconds.
async fn spawn_server(server: TestSshServer) -> (u16, String, tokio::sync::oneshot::Receiver<()>) {
    let host_key_path = std::env::temp_dir().join("easy-console-test-hostkey.pem");
    if !host_key_path.exists() {
        generate_key_pair(&std::env::temp_dir(), "easy-console-test-hostkey.pem", "");
    }
    let host_key = load_host_key(&host_key_path);
    let fingerprint = host_key
        .public_key()
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();

    let config = Arc::new(russh::server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(50),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..<_>::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind the test SSH server");
    let port = listener.local_addr().unwrap().port();
    let mut server = server;
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
        let _ = done_tx.send(());
    });
    (port, fingerprint, done_rx)
}

fn password_request(port: u16, password: &str, keepalive: u64) -> SshConnectionRequest {
    SshConnectionRequest {
        host: "127.0.0.1".into(),
        port: Some(port.to_string()),
        username: Some("ubuntu".into()),
        password: Some(password.into()),
        command: None,
        task_id: None,
        task_name: None,
        cols: Some(80),
        rows: Some(24),
        connect_timeout_sec: Some(10),
        keepalive_interval_sec: Some(keepalive),
        term_type: Some("xterm-256color".into()),
        ssh_key_path: None,
        auth_mode: Some("password".into()),
    }
}

fn key_request(port: u16, key_path: &str) -> SshConnectionRequest {
    SshConnectionRequest {
        auth_mode: Some("key".into()),
        ssh_key_path: Some(key_path.into()),
        password: None,
        ..password_request(port, "", 0)
    }
}

struct SessionUnderTest {
    /// Owner window for this session: events are emitted to its label. Each
    /// session gets its own window, mirroring a popped-out terminal.
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    #[allow(dead_code)] // kept so tests can log which session produced events
    session_id: String,
    tx: mpsc::UnboundedSender<SshCommand>,
    /// Bounded input queue consumed by the session's channel writer (what
    /// `ssh_write` feeds in production).
    input_tx: mpsc::Sender<Vec<u8>>,
    events: mpsc::UnboundedReceiver<TestSessionEvent>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

/// Starts `run_russh_session` against the server and captures the session
/// events the way the owner window would receive them.
async fn start_session(
    app: &tauri::App<tauri::test::MockRuntime>,
    request: SshConnectionRequest,
) -> SessionUnderTest {
    let window = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        format!("ssh-test-{}", uuid::Uuid::new_v4()),
        Default::default(),
    )
    .build()
    .expect("mock window");
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    window.listen("ssh-session-event", move |event| {
        if let Ok(payload) = serde_json::from_str::<TestSessionEvent>(event.payload()) {
            let _ = event_tx.send(payload);
        }
    });

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel();
    let (input_tx, input_rx) = mpsc::channel(64);
    let task = tokio::spawn(run_russh_session(
        app.handle().clone(),
        session_id.clone(),
        request,
        tx.clone(),
        rx,
        input_rx,
        window.label().to_string(),
    ));
    SessionUnderTest {
        window,
        session_id,
        tx,
        input_tx,
        events: event_rx,
        task,
    }
}

async fn next_event(events: &mut mpsc::UnboundedReceiver<TestSessionEvent>) -> TestSessionEvent {
    tokio::time::timeout(TEST_TIMEOUT, events.recv())
        .await
        .expect("session events must arrive in time")
        .expect("the session event channel stays open")
}

/// Waits for the first event of the given kind (skipping earlier ones).
async fn wait_for_kind(
    events: &mut mpsc::UnboundedReceiver<TestSessionEvent>,
    kind: &str,
) -> TestSessionEvent {
    loop {
        let event = next_event(events).await;
        if event.kind == kind {
            return event;
        }
    }
}

/// Waits for the "connected" phase of a status event.
async fn wait_for_connected(
    events: &mut mpsc::UnboundedReceiver<TestSessionEvent>,
) -> TestSessionEvent {
    loop {
        let event = next_event(events).await;
        if event.kind == "status" && event.phase.as_deref() == Some("connected") {
            return event;
        }
    }
}

async fn wrong_password_fails_the_session() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "welcome".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "wrong", 0)).await;
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("the failed session must end in time");
    assert!(
        result.expect("join").is_err(),
        "wrong password must fail the session"
    );
    let _ = session.window.close();
}

async fn correct_password_connects_and_closes_cleanly() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "welcome-band".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    // keepalive_interval_sec = 0 is the documented "disabled" value: the
    // session must connect and stay stable instead of arming a zero timer.
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    wait_for_connected(&mut session.events).await;

    // Echo: write reaches the server and comes back through the output path.
    session
        .input_tx
        .send(b"ping".to_vec())
        .await
        .expect("session is alive");
    let output = wait_for_kind(&mut session.events, "output").await;
    assert!(output.data.unwrap_or_default().contains("ping"));

    session
        .tx
        .send(SshCommand::Close)
        .expect("session is alive");
    let result = tokio::time::timeout(TEST_TIMEOUT, session.task)
        .await
        .expect("the session must close in time")
        .expect("join");
    // run_russh_session returns Ok on a clean Close; the "closed" event itself
    // is emitted by the open_ssh_session wrapper, which this direct call skips.
    assert!(result.is_ok(), "clean close must return Ok");
    let _ = session.window.close();
}

/// SSH-P2-07: with the server refusing to read (its flow-control window never
/// replenishes), a large paste must not block session control. The command
/// loop no longer performs channel writes inline, so Close is honored and
/// teardown aborts the stalled writer instead of queueing behind it.
async fn large_input_cannot_block_session_control() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "welcome-stall".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: true,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    wait_for_connected(&mut session.events).await;

    // 8 MiB in 16 KiB chunks — far beyond the server's receive window plus the
    // 1 MiB input queue — so the writer task is guaranteed to stall. Feeding
    // the queue happens on its own task, like the awaited `ssh_write` sends.
    let input_tx = session.input_tx.clone();
    let feeder = tokio::spawn(async move {
        for _ in 0..512 {
            if input_tx.send(vec![b'x'; 16 * 1024]).await.is_err() {
                break; // the session closed and dropped the input queue
            }
        }
    });

    session
        .tx
        .send(SshCommand::Close)
        .expect("session is alive");
    let result = tokio::time::timeout(TEST_TIMEOUT, session.task)
        .await
        .expect("Close must retire the session while a paste is stalled")
        .expect("join");
    assert!(result.is_ok(), "clean close must return Ok");
    let _ = session.window.close();
    feeder.abort();
}

async fn private_key_auth_accepts_and_rejects_keys() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    // The key the server authorizes is the one phase 2 signs in with.
    let (allowed_key, _) = generate_key_pair(&std::env::temp_dir(), "ec-test-allowed", "");
    let authorized_public_key =
        russh::keys::load_secret_key(allowed_key.to_string_lossy().as_ref(), None)
            .unwrap()
            .public_key()
            .clone();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: String::new(),
        authorized_public_key: Some(authorized_public_key),
        shell_banner: "key-ok".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");

    // A fresh key the server does not know must be rejected.
    let (rejected_key, _) = generate_key_pair(&std::env::temp_dir(), "ec-test-rejected", "");
    let mut rejected_session =
        start_session(&app, key_request(port, rejected_key.to_str().unwrap())).await;
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut rejected_session.task)
        .await
        .expect("rejection in time");
    assert!(result.expect("join").is_err(), "unauthorized key must fail");

    // The authorized key must connect; `~` in the key path must expand natively.
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .expect("home directory exists");
    let relative = allowed_key
        .strip_prefix(&home)
        .expect("key lives under home");
    let mut request = key_request(port, allowed_key.to_str().unwrap());
    request.ssh_key_path = Some(format!(
        "~/{}",
        relative.to_string_lossy().replace('\\', "/")
    ));
    let mut session = start_session(&app, request).await;
    wait_for_connected(&mut session.events).await;
    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = rejected_session.window.close();
    let _ = session.window.close();
}

async fn host_key_prompt_confirms_first_connection() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, _fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "tofu-ok".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let mut first_session = start_session(&app, password_request(port, "correct", 0)).await;
    let prompt = wait_for_kind(&mut first_session.events, "host-key-prompt").await;
    let payload = prompt.data.expect("host-key prompt carries data");
    #[derive(Deserialize)]
    struct Prompt {
        #[serde(rename = "promptId")]
        prompt_id: String,
    }
    let prompt_id = serde_json::from_str::<Prompt>(&payload)
        .expect("valid prompt")
        .prompt_id;

    // Rejecting once must fail the connection.
    easy_console_lib::ssh::host_key::confirm_known_host(prompt_id.clone(), false)
        .expect("confirm lands");
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut first_session.task)
        .await
        .expect("rejection in time");
    assert!(
        result.expect("join").is_err(),
        "rejected host key must fail"
    );

    // Second attempt accepted: the connection proceeds and the fingerprint is stored.
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    let prompt = wait_for_kind(&mut session.events, "host-key-prompt").await;
    #[derive(Deserialize)]
    struct Prompt2 {
        #[serde(rename = "promptId")]
        prompt_id: String,
    }
    let prompt_id = serde_json::from_str::<Prompt2>(&prompt.data.expect("data"))
        .unwrap()
        .prompt_id;
    easy_console_lib::ssh::host_key::confirm_known_host(prompt_id, true).expect("confirm lands");
    wait_for_connected(&mut session.events).await;
    let stored =
        easy_console_lib::load_string_map(&known_hosts_store(&app)).expect("store readable");
    assert!(stored.contains_key(&format!("127.0.0.1:{port}")));
    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn changed_host_key_is_rejected() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, _fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "x".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    // Seed a stale fingerprint for this host:port so the real one mismatches.
    persist_known_host(app.handle(), "127.0.0.1", port, "SHA256:stale-key").expect("seed");

    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("mismatch in time");
    assert!(
        result.expect("join").is_err(),
        "a changed host key must be rejected"
    );
    let _ = session.window.close();
}

/// Connects a session with the server's true host key already trusted, so SFTP
/// and forwarding tests skip the interactive prompt.
async fn trusted_session(
    app: &tauri::App<tauri::test::MockRuntime>,
    port: u16,
    fingerprint: &str,
) -> SessionUnderTest {
    persist_known_host(app.handle(), "127.0.0.1", port, fingerprint).expect("trust host");
    let mut session = start_session(app, password_request(port, "correct", 0)).await;
    wait_for_connected(&mut session.events).await;
    session
}

async fn sftp_upload_and_download_round_trip() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "sftp".into(),
        sftp_root: root.clone(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let session = trusted_session(&app, port, &fingerprint).await;

    let local_dir = std::env::temp_dir().join(format!("ec-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let local_file = local_dir.join("upload.bin");
    std::fs::write(&local_file, vec![7_u8; 256 * 1024]).unwrap();

    // Upload → completed outcome; target present; no temp file left.
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpUpload {
            local_path: local_file.to_string_lossy().to_string(),
            remote_path: "~/upload.bin".into(),
            response: response_tx,
        })
        .unwrap();
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("upload resolves")
        .expect("response channel")
        .expect("upload succeeds");
    assert_eq!(outcome.status, "completed");
    assert_eq!(outcome.operation, "upload");
    assert_eq!(outcome.total, 256 * 1024);
    assert_eq!(
        std::fs::read(root.join("upload.bin")).unwrap().len(),
        256 * 1024
    );
    let temp_leftover = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains(".ecpart-"));
    assert!(!temp_leftover, "the upload temp file must be gone");

    // Upload again over the same name: the overwrite path must commit cleanly.
    std::fs::write(&local_file, vec![9_u8; 64 * 1024]).unwrap();
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpUpload {
            local_path: local_file.to_string_lossy().to_string(),
            remote_path: "~/upload.bin".into(),
            response: response_tx,
        })
        .unwrap();
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("upload resolves")
        .expect("response channel")
        .expect("overwrite upload succeeds");
    assert_eq!(outcome.status, "completed");
    assert_eq!(
        std::fs::read(root.join("upload.bin")).unwrap(),
        vec![9_u8; 64 * 1024]
    );

    // Download → completed outcome; content matches; no `.part` left behind.
    let download_target = local_dir.join("downloaded.bin");
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpDownload {
            remote_path: "~/upload.bin".into(),
            local_path: download_target.to_string_lossy().to_string(),
            response: response_tx,
        })
        .unwrap();
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("download resolves")
        .expect("response channel")
        .expect("download succeeds");
    assert_eq!(outcome.status, "completed");
    assert_eq!(outcome.operation, "download");
    assert_eq!(
        std::fs::read(&download_target).unwrap(),
        vec![9_u8; 64 * 1024]
    );
    assert!(
        !local_dir.join("downloaded.bin.part").exists(),
        "no .part after success"
    );

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn sftp_cancel_aborts_upload_and_leaves_no_remote_file() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "cancel".into(),
        sftp_root: root.clone(),
        // Slow writes keep the transfer in flight for the cancel to hit.
        transfer_delay: Some(Duration::from_millis(300)),
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let session = trusted_session(&app, port, &fingerprint).await;

    let local_dir = std::env::temp_dir().join(format!("ec-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let local_file = local_dir.join("big.bin");
    std::fs::write(&local_file, vec![1_u8; 2 * 1024 * 1024]).unwrap();

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpUpload {
            local_path: local_file.to_string_lossy().to_string(),
            remote_path: "~/big.bin".into(),
            response: response_tx,
        })
        .unwrap();

    // Let a couple of writes land, then cancel the latest transfer.
    tokio::time::sleep(Duration::from_millis(700)).await;
    let (cancel_tx, cancel_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::CancelSftp {
            transfer_id: None,
            response: cancel_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, cancel_rx)
        .await
        .expect("cancel resolves")
        .expect("response channel")
        .expect("cancel delivered");

    // The transfer's own command resolves with a canceled outcome.
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("canceled transfer resolves")
        .expect("response channel")
        .expect("cancel surfaces as a canceled outcome, not an error");
    assert_eq!(outcome.status, "canceled");
    assert_eq!(outcome.operation, "upload");

    // Neither the target nor the remote temp file may remain. The cleanup runs
    // right after the abort lands, so poll briefly.
    let mut temp_gone = false;
    for _ in 0..40 {
        temp_gone = !std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("big.bin"));
        if temp_gone {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        temp_gone,
        "canceled upload must leave no remote file at all"
    );

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn sftp_cancel_removes_local_part_file() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("remote.bin"), vec![3_u8; 2 * 1024 * 1024]).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "part".into(),
        sftp_root: root,
        transfer_delay: Some(Duration::from_millis(300)),
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let session = trusted_session(&app, port, &fingerprint).await;

    let local_dir = std::env::temp_dir().join(format!("ec-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let target = local_dir.join("remote.bin");

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpDownload {
            remote_path: "~/remote.bin".into(),
            local_path: target.to_string_lossy().to_string(),
            response: response_tx,
        })
        .unwrap();

    tokio::time::sleep(Duration::from_millis(700)).await;
    let (cancel_tx, cancel_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::CancelSftp {
            transfer_id: None,
            response: cancel_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, cancel_rx)
        .await
        .expect("cancel resolves")
        .expect("response channel")
        .expect("cancel delivered");

    let outcome: Result<SftpTransferOutcome, String> =
        tokio::time::timeout(TEST_TIMEOUT, response_rx)
            .await
            .expect("canceled transfer resolves")
            .expect("response channel");
    assert_eq!(outcome.expect("canceled outcome").status, "canceled");

    // The `.part` file must be cleaned up, and no full file may exist.
    let mut part_gone = false;
    for _ in 0..40 {
        part_gone = !local_dir.join("remote.bin.part").exists();
        if part_gone {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(part_gone, "the .part file must be removed after cancel");
    assert!(
        !target.exists(),
        "canceled download must not leave the target"
    );

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn port_forward_rules_track_their_lifecycle() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "fwd".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let mut session = trusted_session(&app, port, &fingerprint).await;

    // Find a free local port by binding and releasing it (tiny race, fine here).
    let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let local_port = probe.local_addr().unwrap().port();
    drop(probe);

    let rule = PortForwardRuleValue {
        id: "rule-1".into(),
        forward_type: "local".into(),
        local_host: "127.0.0.1".into(),
        local_port,
        remote_host: "example.invalid".into(),
        remote_port: 80,
        enabled: true,
    };

    // A started rule reports active, and a duplicate start is rejected.
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule: rule.clone(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("start resolves")
        .expect("response channel")
        .expect("start succeeds");
    let active = wait_for_kind(&mut session.events, "port-forward-status").await;
    assert!(active.data.unwrap_or_default().contains("\"active\":true"));

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule: rule.clone(),
            response: response_tx,
        })
        .unwrap();
    let duplicate = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("duplicate resolves")
        .expect("response channel");
    assert!(duplicate.is_err(), "starting a running rule must fail");

    // Stopping emits inactive and frees the rule for a restart.
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StopPortForward {
            rule_id: rule.id.clone(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("stop resolves")
        .expect("response channel")
        .expect("stop succeeds");
    let inactive = wait_for_kind(&mut session.events, "port-forward-status").await;
    assert!(inactive
        .data
        .unwrap_or_default()
        .contains("\"active\":false"));

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule,
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("restart resolves")
        .expect("response channel")
        .expect("restart after stop succeeds");

    // A listener that dies on its own must retire its rule with an inactive
    // event instead of lingering as active.
    session
        .tx
        .send(SshCommand::ForwardListenerDied {
            rule_id: "rule-1".into(),
            error: "boom".into(),
        })
        .unwrap();
    // The restart's own active event may still be queued ahead of the death
    // event; skip until the retirement with the injected error arrives.
    let payload = loop {
        let event = wait_for_kind(&mut session.events, "port-forward-status").await;
        let payload = event.data.unwrap_or_default();
        if payload.contains("boom") {
            break payload;
        }
    };
    assert!(payload.contains("\"active\":false"));

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

/// SSH-P2-08: a tunneled connection must not outlive its rule. The mock
/// server accepts direct-tcpip channels and holds them open, so the tunnel
/// stays alive until StopPortForward aborts it — the client socket must then
/// close and the port must be reusable immediately.
async fn port_forward_stop_aborts_tunneled_connections() {
    use tokio::io::AsyncReadExt as _;

    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "fwd-tunnel".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    let mut session = trusted_session(&app, port, &fingerprint).await;

    // Find a free local port by binding and releasing it (tiny race, fine here).
    let probe = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let local_port = probe.local_addr().unwrap().port();
    drop(probe);

    let rule = PortForwardRuleValue {
        id: "tunnel-rule".into(),
        forward_type: "local".into(),
        local_host: "127.0.0.1".into(),
        local_port,
        remote_host: "example.invalid".into(),
        remote_port: 80,
        enabled: true,
    };

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule: rule.clone(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("start resolves")
        .expect("response channel")
        .expect("start succeeds");
    wait_for_kind(&mut session.events, "port-forward-status").await;

    // Open a tunneled connection; the mock server accepts the direct-tcpip
    // channel and holds it, so the tunnel stays established but silent.
    let mut tunneled = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
        .await
        .expect("tunnel connects");
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Stopping the rule aborts the accept loop and, through its JoinSet,
    // every tunneled connection.
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StopPortForward {
            rule_id: rule.id.clone(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("stop resolves")
        .expect("response channel")
        .expect("stop succeeds");

    let mut buf = [0_u8; 16];
    match tokio::time::timeout(Duration::from_secs(5), tunneled.read(&mut buf)).await {
        Ok(Ok(0)) => {}  // graceful close
        Ok(Err(_)) => {} // reset — also fine on abort
        Ok(Ok(n)) => panic!("tunnel delivered unexpected data: {n} bytes"),
        Err(_) => panic!("tunneled connection must close when its rule stops"),
    }

    // The listener socket must be freed immediately.
    let rebind = tokio::net::TcpListener::bind(("127.0.0.1", local_port)).await;
    assert!(
        rebind.is_ok(),
        "the forwarding port must be reusable after stop"
    );

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

/// With `posix-rename@openssh.com` supported, an overwrite upload must commit
/// through the atomic extended request (the server observes it) instead of the
/// two-step remove-then-rename fallback.
async fn sftp_overwrite_uses_atomic_posix_rename() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let posix_seen = Arc::new(AtomicBool::new(false));
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "sftp-atomic".into(),
        sftp_root: root.clone(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: true,
        posix_rename_seen: Arc::clone(&posix_seen),
    })
    .await;

    let session = trusted_session(&app, port, &fingerprint).await;

    let local_dir = std::env::temp_dir().join(format!("ec-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&local_dir).unwrap();
    let local_file = local_dir.join("atomic.bin");
    std::fs::write(&local_file, vec![7_u8; 32 * 1024]).unwrap();

    let upload = |session: &SessionUnderTest, local_path: String| {
        let (response_tx, response_rx) = oneshot::channel();
        session
            .tx
            .send(SshCommand::SftpUpload {
                local_path,
                remote_path: "~/overwrite.bin".into(),
                response: response_tx,
            })
            .unwrap();
        response_rx
    };

    // Initial upload: target does not exist, plain rename commits.
    let response_rx = upload(&session, local_file.to_string_lossy().to_string());
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("upload resolves")
        .expect("response channel")
        .expect("upload succeeds");
    assert_eq!(outcome.status, "completed");

    // Overwrite: plain rename fails on the existing target, so the commit must
    // go through the posix-rename extended request.
    std::fs::write(&local_file, vec![9_u8; 32 * 1024]).unwrap();
    let response_rx = upload(&session, local_file.to_string_lossy().to_string());
    let outcome = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("overwrite resolves")
        .expect("response channel")
        .expect("overwrite upload succeeds");
    assert_eq!(outcome.status, "completed");
    assert_eq!(
        std::fs::read(root.join("overwrite.bin")).unwrap(),
        vec![9_u8; 32 * 1024]
    );
    assert!(
        posix_seen.load(Ordering::Relaxed),
        "the overwrite must commit through the atomic posix-rename path"
    );

    let temp_leftover = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains(".ecpart-"));
    assert!(!temp_leftover, "the upload temp file must be gone");

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn minimal_two_key_connections() {
    // Pure russh repro: two sequential key-auth connections against the mock
    // server — the first rejected, the second authorized.
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (authorized, _) = generate_key_pair(&std::env::temp_dir(), "ec-min-authorized", "");
    let authorized_public_key =
        russh::keys::load_secret_key(authorized.to_string_lossy().as_ref(), None)
            .unwrap()
            .public_key()
            .clone();
    let (port, _fp, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: String::new(),
        authorized_public_key: Some(authorized_public_key),
        shell_banner: "x".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let (rejected, _) = generate_key_pair(&std::env::temp_dir(), "ec-min-rejected", "");

    use russh::client;
    struct NoCheck;
    impl client::Handler for NoCheck {
        type Error = russh::Error;
        async fn check_server_key(
            &mut self,
            _key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }
    let config = Arc::new(client::Config::default());

    let mut conn = client::connect(config.clone(), ("127.0.0.1", port), NoCheck)
        .await
        .unwrap();
    let key = russh::keys::load_secret_key(rejected.to_string_lossy().as_ref(), None).unwrap();
    let auth = conn
        .authenticate_publickey(
            "ubuntu",
            russh::keys::PrivateKeyWithHashAlg::new(
                Arc::new(key),
                Some(russh::keys::ssh_key::HashAlg::Sha256),
            ),
        )
        .await
        .unwrap();
    assert!(!auth.success(), "rejected key must fail");
    // Disconnect deliberately omitted: mirrors run_russh_session's error path,
    // which drops the Handle without a graceful disconnect.
    drop(conn);

    let mut conn = client::connect(config, ("127.0.0.1", port), NoCheck)
        .await
        .unwrap();
    let key = russh::keys::load_secret_key(authorized.to_string_lossy().as_ref(), None).unwrap();
    let auth = conn
        .authenticate_publickey(
            "ubuntu",
            russh::keys::PrivateKeyWithHashAlg::new(
                Arc::new(key),
                Some(russh::keys::ssh_key::HashAlg::Sha256),
            ),
        )
        .await
        .unwrap();
    assert!(auth.success(), "authorized key must succeed");
}

async fn reconnect_after_auth_failure_connects() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    // The server authorizes exactly one key; round 1 signs in with it.
    let (authorized, _) = generate_key_pair(&std::env::temp_dir(), "ec-reauth-authorized", "");
    let authorized_public_key =
        russh::keys::load_secret_key(authorized.to_string_lossy().as_ref(), None)
            .unwrap()
            .public_key()
            .clone();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: Some(authorized_public_key),
        shell_banner: "again".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");

    // Round 0 ends with a failed password authentication.
    let mut failed = start_session(&app, password_request(port, "wrong", 0)).await;
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut failed.task)
        .await
        .expect("fail in time");
    assert!(result.expect("join").is_err());

    // Round 1 connects with the authorized key.
    let mut session = start_session(&app, key_request(port, authorized.to_str().unwrap())).await;
    wait_for_connected(&mut session.events).await;
    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = failed.window.close();
    let _ = session.window.close();
}

async fn second_connection_to_the_same_server_connects() {
    let app = mock_app();
    let root = std::env::temp_dir().join(format!("ec-sftp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "again".into(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    for round in 0..2 {
        persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
        let mut session = start_session(&app, password_request(port, "correct", 0)).await;
        wait_for_connected(&mut session.events).await;
        session.tx.send(SshCommand::Close).expect("alive");
        let result = tokio::time::timeout(TEST_TIMEOUT, session.task)
            .await
            .expect("close in time")
            .expect("join");
        assert!(result.is_ok(), "round {round} must close cleanly");
        let _ = session.window.close();
    }
}

async fn cross_window_session_access_is_rejected() {
    let app = mock_app();
    let owner =
        tauri::webview::WebviewWindowBuilder::new(app.handle(), "ssh-owner", Default::default())
            .build()
            .expect("owner window");
    let outsider =
        tauri::webview::WebviewWindowBuilder::new(app.handle(), "ssh-outsider", Default::default())
            .build()
            .expect("outsider window");

    let state = SshSessionState::default();
    let (tx, _rx) = mpsc::unbounded_channel();
    let (input_tx, _input_rx) = mpsc::channel(1);
    state.insert_test_entry("session-1", owner.label(), tx, input_tx);

    // The owner window resolves the session; another window with the same id
    // must be refused, and an unknown id must not leak which case failed.
    assert!(state.resolve_owned(&owner, "session-1").is_ok());
    assert!(state.resolve_owned(&outsider, "session-1").is_err());
    assert!(state.resolve_owned(&owner, "missing-session").is_err());
}

/// Custom test harness: each test runs in its own freshly spawned process.
/// The SSH stack (russh client sessions, SFTP workers, the mock server) keeps
/// detached background tasks and global state alive across a single process,
/// which made in-process sequencing timing-flaky; one process per test makes
/// every test start from a clean slate. EC_TEST_SINGLE=<name> is set by the
/// parent process to run exactly one test.
fn spawn_test(self_exe: &std::path::Path, name: &str) -> std::process::ExitStatus {
    std::process::Command::new(self_exe)
        .args(["--exact", name, "--nocapture"])
        .env("EC_TEST_SINGLE", name)
        .status()
        .expect("spawn the test subprocess")
}

fn main() {
    if let Ok(single) = std::env::var("EC_TEST_SINGLE") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let future = match single.as_str() {
            "wrong_password_fails_the_session" => box_test(wrong_password_fails_the_session()),
            "correct_password_connects_and_closes_cleanly" => {
                box_test(correct_password_connects_and_closes_cleanly())
            }
            "large_input_cannot_block_session_control" => {
                box_test(large_input_cannot_block_session_control())
            }
            "private_key_auth_accepts_and_rejects_keys" => {
                box_test(private_key_auth_accepts_and_rejects_keys())
            }
            "host_key_prompt_confirms_first_connection" => {
                box_test(host_key_prompt_confirms_first_connection())
            }
            "changed_host_key_is_rejected" => box_test(changed_host_key_is_rejected()),
            "sftp_upload_and_download_round_trip" => {
                box_test(sftp_upload_and_download_round_trip())
            }
            "sftp_cancel_aborts_upload_and_leaves_no_remote_file" => {
                box_test(sftp_cancel_aborts_upload_and_leaves_no_remote_file())
            }
            "sftp_cancel_removes_local_part_file" => {
                box_test(sftp_cancel_removes_local_part_file())
            }
            "sftp_overwrite_uses_atomic_posix_rename" => {
                box_test(sftp_overwrite_uses_atomic_posix_rename())
            }
            "port_forward_rules_track_their_lifecycle" => {
                box_test(port_forward_rules_track_their_lifecycle())
            }
            "port_forward_stop_aborts_tunneled_connections" => {
                box_test(port_forward_stop_aborts_tunneled_connections())
            }
            "minimal_two_key_connections" => box_test(minimal_two_key_connections()),
            "reconnect_after_auth_failure_connects" => {
                box_test(reconnect_after_auth_failure_connects())
            }
            "second_connection_to_the_same_server_connects" => {
                box_test(second_connection_to_the_same_server_connects())
            }
            "cross_window_session_access_is_rejected" => {
                box_test(cross_window_session_access_is_rejected())
            }
            other => panic!("unknown test {other}"),
        };
        runtime.block_on(future);
        return;
    }

    let self_exe = std::env::current_exe().expect("current exe");
    // Honor cargo's test-name filters (arguments that are not flags).
    let filters: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();
    let selected: Vec<&str> = TESTS
        .iter()
        .copied()
        .filter(|name| filters.is_empty() || filters.iter().any(|f| name.contains(f.as_str())))
        .collect();
    let mut failures: Vec<String> = Vec::new();
    for name in selected {
        print!("test {name} ... ");
        use std::io::Write as _;
        std::io::stdout().flush().ok();
        // russh-sftp's loopback client/server pair very rarely mis-dispatches a
        // response, hanging one transfer until the harness timeout. A failed
        // test is retried in a fresh process before being reported.
        let mut status = spawn_test(&self_exe, name);
        let mut attempt = 0;
        while !status.success() && attempt < 2 {
            attempt += 1;
            println!("(retry {attempt}) ");
            status = spawn_test(&self_exe, name);
        }
        match status.success() {
            true => println!("ok"),
            false => {
                println!("FAILED");
                failures.push(name.to_string());
            }
        }
    }

    if !failures.is_empty() {
        eprintln!("failures: {failures:?}");
        std::process::exit(1);
    }
}
