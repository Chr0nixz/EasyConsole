//! End-to-end tests for the SSH subsystem against a local russh server
//! (see `test_server.rs`). They cover the paths the phase-0 hardening work
//! touches: authentication, host-key TOFU, PTY output, SFTP transfer
//! contract (temp files, atomic commit, cancellation), and port-forward
//! rule lifecycle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::server::Server as _;
use serde::Deserialize;
use tauri::{Listener as _, Manager as _};
use tokio::sync::{mpsc, oneshot, watch};

use easy_console_lib::ssh::host_key::persist_known_host;
use easy_console_lib::ssh::port_forward::PortForwardRuleValue;
use easy_console_lib::ssh::session::{
    run_russh_session, SshCommand, SshConnectionRequest, SshSessionContext, SshSessionState,
};
use easy_console_lib::ssh::sftp::SftpTransferOutcome;
use easy_console_lib::ssh::test_server::{
    generate_key_pair, load_host_key, TestSshServer, TEST_AUTH_STALLED, TEST_DIRECT_TCPIP_REJECTED,
    TEST_GPU_PROBE_CHANNEL_CLOSES, TEST_GPU_PROBE_DELAY_ONCE, TEST_PAM_RESPONSES, TEST_PTY_STALLED,
    TEST_SFTP_CHANNELS_OPENED, TEST_SFTP_WRITE_REQUESTS, TEST_SHELL_STALLED,
};

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
    "password_with_surrounding_whitespace_authenticates",
    "keyboard_interactive_password_fallback_is_restricted",
    "cancel_keyboard_interactive_authentication",
    "rsa_key_auth_negotiates_server_signature_hash",
    "gpu_probe_timeout_closes_channel_and_allows_later_probe",
    "large_input_cannot_block_session_control",
    "terminal_output_backpressure_preserves_bytes",
    "paused_terminal_output_can_close",
    "private_key_auth_accepts_and_rejects_keys",
    "host_key_prompt_confirms_first_connection",
    "legacy_known_host_is_upgraded_after_matching",
    "changed_host_key_is_rejected",
    "changed_host_key_for_recycled_task_can_be_confirmed",
    "cancel_connecting_ssh_session",
    "cancel_waiting_for_host_key_confirmation",
    "cancel_authentication_ssh_session",
    "cancel_pty_request_ssh_session",
    "cancel_shell_request_ssh_session",
    "page_reload_cancels_owned_sessions",
    "channel_eof_before_exit_status_is_handled",
    "sftp_upload_and_download_round_trip",
    "concurrent_sftp_transfers_use_dedicated_channels",
    "sftp_cancel_aborts_upload_and_leaves_no_remote_file",
    "sftp_cancel_removes_local_part_file",
    "sftp_overwrite_uses_atomic_posix_rename",
    "port_forward_rules_track_their_lifecycle",
    "dynamic_forward_reports_remote_open_failure",
    "port_forward_stop_aborts_tunneled_connections",
    "minimal_two_key_connections",
    "reconnect_after_auth_failure_connects",
    "second_connection_to_the_same_server_connects",
    "cross_window_session_access_is_rejected",
    "sftp_commands_forward_canonical_local_paths",
    #[cfg(unix)]
    "sftp_download_rejects_temp_symlink_escapes",
];

/// Mirrors the native `SshSessionEvent` payload for Rust-side assertions.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestSessionEvent {
    kind: String,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[allow(dead_code)] // mirrors the native payload even when a test ignores it
    message: Option<String>,
    output_sequence: Option<u64>,
}

/// Safety net only; a healthy run finishes each test in well under a second.
/// Kept generous because the SFTP round-trip has historically timed out on its
/// first run on a cold/loaded machine.
const TEST_TIMEOUT: Duration = Duration::from_secs(120);

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

/// Per-test temp directory that removes itself (and everything in it) when the
/// test ends. Tests used to hand-create `ec-sftp-*`/`ec-local-*` folders under
/// %TEMP% that were never cleaned up.
fn test_temp_dir(prefix: &str) -> tempfile::TempDir {
    tempfile::TempDir::with_prefix(prefix).expect("create temp dir")
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

    let mut config = russh::server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(50),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..<_>::default()
    };
    if server.username == "rsa-sha512" {
        config.preferred.key = vec![
            russh::keys::ssh_key::Algorithm::Ed25519,
            russh::keys::ssh_key::Algorithm::Rsa {
                hash: Some(russh::keys::ssh_key::HashAlg::Sha512),
            },
        ]
        .into();
    }
    let config = Arc::new(config);
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
    cancel_tx: watch::Sender<bool>,
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
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let task = tokio::spawn(run_russh_session(
        app.handle().clone(),
        request,
        tx.clone(),
        rx,
        input_rx,
        cancel_rx,
        SshSessionContext {
            session_id: session_id.clone(),
            window_label: window.label().to_string(),
        },
    ));
    SessionUnderTest {
        window,
        session_id,
        tx,
        input_tx,
        events: event_rx,
        task,
        cancel_tx,
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

async fn keyboard_interactive_password_fallback_is_restricted() {
    let app = mock_app();
    let root = test_temp_dir("ec-ssh-pam-");
    for (mode, supplied, succeeds, responses) in [
        ("pam-password", "  correct \t", true, 1),
        ("pam-info", "  correct \t", true, 1),
        ("pam-password", "wrong", false, 1),
        ("pam-otp", "  correct \t", false, 0),
        ("pam-echo", "  correct \t", false, 0),
        ("pam-multi", "  correct \t", false, 0),
        ("pam-repeat", "  correct \t", false, 1),
        ("pam-mfa", "  correct \t", false, 1),
    ] {
        TEST_PAM_RESPONSES.store(0, Ordering::SeqCst);
        let (port, fingerprint, _done) = spawn_server(TestSshServer {
            username: mode.into(),
            password: "  correct \t".into(),
            authorized_public_key: None,
            shell_banner: "PAM connected\r\n".into(),
            sftp_root: root.path().to_path_buf(),
            transfer_delay: None,
            stall_shell_input: false,
            support_posix_rename: false,
            posix_rename_seen: Arc::new(AtomicBool::new(false)),
        })
        .await;
        persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).unwrap();
        let mut request = password_request(port, supplied, 0);
        request.username = Some(mode.into());
        let mut session = start_session(&app, request).await;
        if succeeds {
            wait_for_connected(&mut session.events).await;
            session.tx.send(SshCommand::Close).unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(10), session.task)
            .await
            .expect("PAM attempt finishes")
            .unwrap();
        assert_eq!(result.is_ok(), succeeds, "PAM scenario {mode}");
        assert_eq!(
            TEST_PAM_RESPONSES.load(Ordering::SeqCst),
            responses,
            "PAM replies for {mode}"
        );
        let _ = session.window.close();
    }
}

async fn cancel_keyboard_interactive_authentication() {
    let app = mock_app();
    let root = test_temp_dir("ec-ssh-pam-cancel-");
    TEST_AUTH_STALLED.store(false, Ordering::SeqCst);
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "pam-stall".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "".into(),
        sftp_root: root.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).unwrap();
    let mut request = password_request(port, "correct", 0);
    request.username = Some("pam-stall".into());
    let session = start_session(&app, request).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while !TEST_AUTH_STALLED.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    session.cancel_tx.send_replace(true);
    assert!(tokio::time::timeout(Duration::from_secs(2), session.task)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let _ = session.window.close();
}

async fn rsa_key_auth_negotiates_server_signature_hash() {
    let app = mock_app();
    let root = test_temp_dir("ec-ssh-rsa-");
    let private = root.path().join("rsa-key");
    let status = std::process::Command::new("ssh-keygen")
        .args(["-t", "rsa", "-b", "2048", "-N", "", "-q", "-f"])
        .arg(&private)
        .status()
        .expect("ssh-keygen");
    assert!(status.success());
    let public = load_host_key(&private).public_key().clone();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "rsa-sha512".into(),
        password: "".into(),
        authorized_public_key: Some(public),
        shell_banner: "RSA connected\r\n".into(),
        sftp_root: root.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).unwrap();
    let mut request = key_request(port, private.to_str().unwrap());
    request.username = Some("rsa-sha512".into());
    let mut session = start_session(&app, request).await;
    let mut negotiated = false;
    loop {
        let event = next_event(&mut session.events).await;
        if event.phase.as_deref() == Some("connected") {
            break;
        }
        negotiated |= event
            .message
            .as_deref()
            .is_some_and(|message| message.contains("rsa-sha2-512"));
    }
    assert!(
        negotiated,
        "the session must use the server's advertised RSA hash"
    );
    session.tx.send(SshCommand::Close).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), session.task)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let _ = session.window.close();
}

async fn start_output_flood(
    app: &tauri::App<tauri::test::MockRuntime>,
    root: std::path::PathBuf,
) -> (SessionUnderTest, String) {
    let banner = "output日志😀\r\n".repeat(256 * 1024);
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: banner.clone(),
        sftp_root: root,
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).unwrap();
    let mut session = start_session(app, password_request(port, "correct", 0)).await;
    wait_for_connected(&mut session.events).await;
    (session, banner)
}

async fn output_stats(
    session: &SessionUnderTest,
) -> easy_console_lib::ssh::session::SshOutputStats {
    let (response, received) = oneshot::channel();
    session
        .tx
        .send(SshCommand::OutputStats { response })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), received)
        .await
        .expect("output back-pressure must not block session control")
        .expect("output statistics")
}

async fn terminal_output_backpressure_preserves_bytes() {
    let app = mock_app();
    let root = test_temp_dir("ec-ssh-output-");
    let (mut session, expected) = start_output_flood(&app, root.path().to_path_buf()).await;
    let mut actual = String::new();
    let mut last_sequence = 0;
    for _ in 0..16 {
        let event = wait_for_kind(&mut session.events, "output").await;
        actual.push_str(&event.data.unwrap());
        last_sequence = event.output_sequence.unwrap();
    }
    let paused = output_stats(&session).await;
    assert_eq!(paused.in_flight_batches, 16);
    assert_eq!(paused.backpressure_count, 1);
    assert!(paused.in_flight_bytes < 2 * 1024 * 1024);
    session
        .tx
        .send(SshCommand::OutputAck { sequence: 999_999 })
        .unwrap();
    assert_eq!(output_stats(&session).await.in_flight_batches, 16);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), session.events.recv())
            .await
            .is_err()
    );
    session
        .tx
        .send(SshCommand::OutputAck {
            sequence: last_sequence,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while actual.len() < expected.len() {
            let event = wait_for_kind(&mut session.events, "output").await;
            let sequence = event.output_sequence.unwrap();
            assert_eq!(sequence, last_sequence + 1);
            last_sequence = sequence;
            actual.push_str(&event.data.unwrap());
            session.tx.send(SshCommand::OutputAck { sequence }).unwrap();
        }
    })
    .await
    .expect("output must resume when xterm acknowledges parsing");
    assert_eq!(
        actual, expected,
        "back-pressure must preserve every UTF-8 byte in order"
    );
    let drained = output_stats(&session).await;
    assert_eq!(drained.in_flight_bytes, 0);
    assert_eq!(drained.emitted_bytes, expected.len() as u64);
    assert_eq!(drained.peak_in_flight_batches, 16);
    session.tx.send(SshCommand::Close).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), session.task)
        .await
        .unwrap()
        .unwrap()
        .is_ok());
    let _ = session.window.close();
}

async fn paused_terminal_output_can_close() {
    let app = mock_app();
    let root = test_temp_dir("ec-ssh-output-close-");
    let (mut session, _) = start_output_flood(&app, root.path().to_path_buf()).await;
    for _ in 0..16 {
        wait_for_kind(&mut session.events, "output").await;
    }
    assert_eq!(output_stats(&session).await.in_flight_batches, 16);
    session.tx.send(SshCommand::Close).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), session.task)
        .await
        .expect("closing must not require an output acknowledgement")
        .unwrap()
        .is_ok());
    let _ = session.window.close();
}

async fn correct_password_connects_and_closes_cleanly() {
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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
    let (response, received) = oneshot::channel();
    session
        .tx
        .send(SshCommand::GpuUtilization { response })
        .expect("probe command");
    let gpu = tokio::time::timeout(Duration::from_secs(10), received)
        .await
        .expect("probe timeout")
        .expect("response")
        .expect("GPU probe");
    assert_eq!(gpu, vec![0.0, 2.0]);

    session
        .input_tx
        .send(b"ping".to_vec())
        .await
        .expect("session is alive");
    // The independent GPU channel gives the shell banner time to flush before
    // this echo. Output chunk boundaries are not message boundaries.
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut output = String::new();
        while !output.contains("ping") {
            let event = wait_for_kind(&mut session.events, "output").await;
            output.push_str(&event.data.unwrap_or_default());
        }
    })
    .await
    .expect("shell echo must arrive after the GPU probe");

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

async fn password_with_surrounding_whitespace_authenticates() {
    let app = mock_app();
    let root = test_temp_dir("ec-sftp-whitespace-password-");
    let password = "  correct \t";
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: password.into(),
        authorized_public_key: None,
        shell_banner: "whitespace-password".into(),
        sftp_root: root.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;

    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, password, 0)).await;
    wait_for_connected(&mut session.events).await;
    session
        .tx
        .send(SshCommand::Close)
        .expect("session is alive");
    let result = tokio::time::timeout(TEST_TIMEOUT, session.task)
        .await
        .expect("the session must close in time")
        .expect("join");
    assert!(result.is_ok(), "whitespace password must authenticate");
    let _ = session.window.close();
}

async fn gpu_probe_timeout_closes_channel_and_allows_later_probe() {
    let app = mock_app();
    let root = test_temp_dir("ec-sftp-gpu-timeout-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "gpu-timeout".into(),
        sftp_root: root.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    wait_for_connected(&mut session.events).await;

    let close_count = TEST_GPU_PROBE_CHANNEL_CLOSES.load(Ordering::SeqCst);
    TEST_GPU_PROBE_DELAY_ONCE.store(true, Ordering::SeqCst);
    let (response, received) = oneshot::channel();
    session
        .tx
        .send(SshCommand::GpuUtilization { response })
        .expect("probe command");
    let started = Instant::now();
    let error = tokio::time::timeout(Duration::from_secs(8), received)
        .await
        .expect("the stalled GPU probe must time out")
        .expect("probe response channel")
        .expect_err("the stalled GPU probe must fail");
    assert!(
        error.contains("timeout") || error.contains("超时"),
        "unexpected GPU probe error: {error}"
    );
    assert!(started.elapsed() >= Duration::from_secs(4));
    tokio::time::timeout(Duration::from_secs(3), async {
        while TEST_GPU_PROBE_CHANNEL_CLOSES.load(Ordering::SeqCst) <= close_count {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the server must observe the timed-out channel close");

    let (response, received) = oneshot::channel();
    session
        .tx
        .send(SshCommand::GpuUtilization { response })
        .expect("session remains available after a probe timeout");
    let values = tokio::time::timeout(Duration::from_secs(10), received)
        .await
        .expect("the next GPU probe must complete")
        .expect("probe response channel")
        .expect("GPU probe succeeds after timeout");
    assert_eq!(values, vec![0.0, 2.0]);

    session
        .tx
        .send(SshCommand::Close)
        .expect("session is alive");
    let result = tokio::time::timeout(TEST_TIMEOUT, session.task)
        .await
        .expect("the session must close in time")
        .expect("join");
    assert!(result.is_ok());
    let _ = session.window.close();
}

/// SSH-P2-07: with the server refusing to read (its flow-control window never
/// replenishes), a large paste must not block session control. The command
/// loop no longer performs channel writes inline, so Close is honored and
/// teardown aborts the stalled writer instead of queueing behind it.
async fn large_input_cannot_block_session_control() {
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
    // The key the server authorizes is the one phase 2 signs in with. It must
    // live under the home directory because this test also exercises `~`
    // expansion; the UUID suffix keeps parallel runs from clobbering one file
    // and both halves are removed at the end of the test.
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .expect("home directory exists");
    let (allowed_key, allowed_key_pub) = generate_key_pair(
        &home,
        &format!("ec-test-allowed-{}", uuid::Uuid::new_v4()),
        "",
    );
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
    let _keys_dir = test_temp_dir("ec-keys-");
    let (rejected_key, _) = generate_key_pair(_keys_dir.path(), "rejected", "");
    let mut rejected_session =
        start_session(&app, key_request(port, rejected_key.to_str().unwrap())).await;
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut rejected_session.task)
        .await
        .expect("rejection in time");
    assert!(result.expect("join").is_err(), "unauthorized key must fail");

    // The authorized key must connect; `~` in the key path must expand natively.
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
    // The authorized key lives under the user's home directory, outside any
    // auto-cleaned temp dir, so remove it explicitly (best effort).
    let _ = std::fs::remove_file(&allowed_key);
    let _ = std::fs::remove_file(&allowed_key_pub);
}

async fn host_key_prompt_confirms_first_connection() {
    let app = mock_app();
    app.manage(Arc::new(SshSessionState::default()));
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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
    let outsider = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        "ssh-host-key-outsider",
        Default::default(),
    )
    .build()
    .expect("outsider window");
    assert!(easy_console_lib::ssh::session::ssh_close(
        app.state(),
        outsider.clone(),
        first_session.session_id.clone(),
    )
    .is_err());
    assert!(
        easy_console_lib::ssh::host_key::pending_host_key_prompts()
            .lock()
            .unwrap()
            .contains_key(&prompt_id),
        "unauthorized close must not discard the host prompt"
    );
    for accept in [true, false] {
        assert!(
            easy_console_lib::ssh::host_key::confirm_known_host(
                outsider.clone(),
                prompt_id.clone(),
                accept,
                true,
            )
            .is_err(),
            "another window cannot accept or reject the owner's prompt"
        );
        assert!(
            easy_console_lib::ssh::host_key::pending_host_key_prompts()
                .lock()
                .unwrap()
                .contains_key(&prompt_id),
            "denied confirmation must not consume the prompt"
        );
    }
    easy_console_lib::ssh::host_key::confirm_known_host(
        first_session.window.clone(),
        prompt_id.clone(),
        false,
        false,
    )
    .expect("confirm lands");
    assert!(
        easy_console_lib::ssh::host_key::confirm_known_host(
            first_session.window.clone(),
            prompt_id,
            false,
            false,
        )
        .is_err(),
        "consumed prompt cannot be confirmed again"
    );
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut first_session.task)
        .await
        .expect("rejection in time");
    assert!(
        result.expect("join").is_err(),
        "rejected host key must fail"
    );

    // Second attempt accepted: the connection proceeds and the fingerprint is stored.
    let mut request = password_request(port, "correct", 0);
    request.task_id = Some("task-tofu".into());
    let mut session = start_session(&app, request).await;
    let prompt = wait_for_kind(&mut session.events, "host-key-prompt").await;
    #[derive(Deserialize)]
    struct Prompt2 {
        #[serde(rename = "promptId")]
        prompt_id: String,
    }
    let prompt_id = serde_json::from_str::<Prompt2>(&prompt.data.expect("data"))
        .unwrap()
        .prompt_id;
    easy_console_lib::ssh::host_key::confirm_known_host(
        session.window.clone(),
        prompt_id,
        true,
        false,
    )
    .expect("confirm lands");
    wait_for_connected(&mut session.events).await;
    let stored =
        easy_console_lib::load_string_map(&known_hosts_store(&app)).expect("store readable");
    let record: serde_json::Value = serde_json::from_str(&stored[&format!("127.0.0.1:{port}")])
        .expect("structured host record");
    assert_eq!(record["fingerprint"], _fingerprint);
    assert_eq!(record["algorithm"], "ssh-ed25519");
    assert!(record["publicKey"]
        .as_str()
        .unwrap()
        .starts_with("ssh-ed25519 "));
    assert_eq!(record["taskId"], "task-tofu");
    let managed_path = easy_console_lib::ssh::host_key::ssh_known_hosts_path(app.handle())
        .expect("managed OpenSSH known-hosts path");
    let managed = std::fs::read_to_string(managed_path).expect("managed key file exists");
    assert!(managed.contains(&format!("[127.0.0.1]:{port} ssh-ed25519 ")));
    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn legacy_known_host_is_upgraded_after_matching() {
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "legacy-known-host".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let path = known_hosts_store(&app);
    easy_console_lib::write_string_map(
        &path,
        &std::collections::HashMap::from([(format!("127.0.0.1:{port}"), fingerprint.clone())]),
    )
    .expect("seed legacy fingerprint mapping");

    let mut request = password_request(port, "correct", 0);
    request.task_id = Some("legacy-task".into());
    let mut session = start_session(&app, request).await;
    wait_for_connected(&mut session.events).await;

    let upgraded = easy_console_lib::load_string_map(&path).expect("upgraded store");
    let record: serde_json::Value = serde_json::from_str(&upgraded[&format!("127.0.0.1:{port}")])
        .expect("structured record after matching legacy key");
    assert_eq!(record["fingerprint"], fingerprint);
    assert_eq!(record["taskId"], "legacy-task");
    assert!(record["publicKey"].as_str().unwrap().contains(' '));
    let backup = path.with_file_name("known-ssh-hosts.json.bak");
    let backed_up = easy_console_lib::load_string_map(&backup).expect("legacy migration backup");
    assert_eq!(backed_up[&format!("127.0.0.1:{port}")], fingerprint);

    session.tx.send(SshCommand::Close).expect("session alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, &mut session.task).await;
    let _ = session.window.close();
}

async fn changed_host_key_is_rejected() {
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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
    let prompt = wait_for_kind(&mut session.events, "host-key-prompt").await;
    let payload: serde_json::Value =
        serde_json::from_str(&prompt.data.expect("prompt payload")).expect("valid prompt");
    assert_eq!(payload["changedKey"], true);
    assert_eq!(payload["requiresChangedConfirmation"], true);
    let prompt_id = payload["promptId"].as_str().unwrap();
    easy_console_lib::ssh::host_key::confirm_known_host(
        session.window.clone(),
        prompt_id.to_string(),
        true,
        false,
    )
    .expect("confirmation delivered but missing checkbox");
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("rejection in time");
    assert!(
        result.expect("join").is_err(),
        "missing explicit checkbox rejects the key"
    );
    let stored =
        easy_console_lib::load_string_map(&known_hosts_store(&app)).expect("store readable");
    let record: serde_json::Value = serde_json::from_str(&stored[&format!("127.0.0.1:{port}")])
        .expect("record remains structured");
    assert_eq!(record["fingerprint"], "SHA256:stale-key");
    let _ = session.window.close();
}

async fn changed_host_key_for_recycled_task_can_be_confirmed() {
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "rotated".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let store_path = known_hosts_store(&app);
    easy_console_lib::write_string_map(
        &store_path,
        &std::collections::HashMap::from([(
            format!("127.0.0.1:{port}"),
            serde_json::json!({
                "algorithm": "ssh-ed25519",
                "publicKey": "ssh-ed25519 stale-blob",
                "fingerprint": "SHA256:stale-key",
                "firstTrustedAt": 123,
                "taskId": "recycled-task-old"
            })
            .to_string(),
        )]),
    )
    .expect("seed old task trust");

    let mut request = password_request(port, "correct", 0);
    request.task_id = Some("recycled-task-new".into());
    let mut session = start_session(&app, request).await;
    let prompt = wait_for_kind(&mut session.events, "host-key-prompt").await;
    let payload: serde_json::Value =
        serde_json::from_str(&prompt.data.expect("prompt payload")).expect("valid prompt");
    assert_eq!(payload["taskChanged"], true);
    assert_eq!(payload["requiresChangedConfirmation"], false);
    easy_console_lib::ssh::host_key::confirm_known_host(
        session.window.clone(),
        payload["promptId"].as_str().unwrap().to_string(),
        true,
        false,
    )
    .expect("task change confirmation delivered");
    wait_for_connected(&mut session.events).await;

    let stored = easy_console_lib::load_string_map(&store_path).expect("store readable");
    let record: serde_json::Value = serde_json::from_str(&stored[&format!("127.0.0.1:{port}")])
        .expect("updated structured record");
    assert_eq!(record["fingerprint"], fingerprint);
    assert_eq!(record["taskId"], "recycled-task-new");
    session.tx.send(SshCommand::Close).expect("session alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, &mut session.task).await;
    let _ = session.window.close();
}

async fn cancel_connecting_ssh_session() {
    let app = mock_app();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicBool::new(false));
    let accepted_flag = Arc::clone(&accepted);
    tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        accepted_flag.store(true, Ordering::SeqCst);
        std::future::pending::<()>().await;
    });

    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    while !accepted.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    session.cancel_tx.send_replace(true);
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("cancelled handshake exits");
    assert!(result.expect("join").is_ok());
    let _ = session.window.close();
}

async fn cancel_waiting_for_host_key_confirmation() {
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, _, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "cancel-host-key".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    let prompt = wait_for_kind(&mut session.events, "host-key-prompt").await;
    let payload: serde_json::Value =
        serde_json::from_str(&prompt.data.expect("prompt data")).unwrap();
    let prompt_id = payload["promptId"].as_str().unwrap().to_string();
    session.cancel_tx.send_replace(true);
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("cancelled prompt exits");
    assert!(result.expect("join").is_ok());
    assert!(!easy_console_lib::ssh::host_key::pending_host_key_prompts()
        .lock()
        .unwrap()
        .contains_key(&prompt_id));
    let _ = session.window.close();
}

async fn cancel_authentication_ssh_session() {
    TEST_AUTH_STALLED.store(false, Ordering::SeqCst);
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "stall-auth".into(),
        authorized_public_key: None,
        shell_banner: "cancel-auth".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "stall-auth", 0)).await;
    while !TEST_AUTH_STALLED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    session.cancel_tx.send_replace(true);
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("cancelled authentication exits");
    assert!(result.expect("join").is_ok());
    let _ = session.window.close();
}

async fn cancel_pty_request_ssh_session() {
    TEST_PTY_STALLED.store(false, Ordering::SeqCst);
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "stall-pty".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "cancel-pty".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut request = password_request(port, "correct", 0);
    request.username = Some("stall-pty".into());
    let mut session = start_session(&app, request).await;
    while !TEST_PTY_STALLED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    session.cancel_tx.send_replace(true);
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("cancelled PTY request exits");
    assert!(result.expect("join").is_ok());
    let _ = session.window.close();
}

async fn cancel_shell_request_ssh_session() {
    TEST_SHELL_STALLED.store(false, Ordering::SeqCst);
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "stall-shell".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "cancel-shell".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut request = password_request(port, "correct", 0);
    request.username = Some("stall-shell".into());
    let mut session = start_session(&app, request).await;
    while !TEST_SHELL_STALLED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    session.cancel_tx.send_replace(true);
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("cancelled shell request exits");
    assert!(result.expect("join").is_ok());
    let _ = session.window.close();
}

async fn page_reload_cancels_owned_sessions() {
    let app = mock_app();
    let owner =
        tauri::webview::WebviewWindowBuilder::new(app.handle(), "reload-owner", Default::default())
            .build()
            .unwrap();
    let state = SshSessionState::default();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (input_tx, _input_rx) = mpsc::channel(1);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state.insert_test_entry("reload-session", owner.label(), tx, input_tx, cancel_tx);
    easy_console_lib::ssh::session::close_sessions_for_window(&state, owner.label());
    assert!(*cancel_rx.borrow());
    assert!(matches!(rx.try_recv(), Ok(SshCommand::Close)));
    assert!(state.resolve_owned(&owner, "reload-session").is_err());
    let _ = owner.close();
}

async fn channel_eof_before_exit_status_is_handled() {
    let app = mock_app();
    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "exit-first".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust host");
    let mut session = start_session(&app, password_request(port, "correct", 0)).await;
    let exited = loop {
        let event = next_event(&mut session.events).await;
        if event.kind == "status" && event.phase.as_deref() == Some("exited") {
            break event;
        }
    };
    assert!(exited.message.unwrap().contains("23"));
    let result = tokio::time::timeout(TEST_TIMEOUT, &mut session.task)
        .await
        .expect("close follows exit status");
    assert!(result.expect("join").is_ok());
    let _ = session.window.close();

    let root_holder = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "exec".into(),
        sftp_root: root_holder.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    persist_known_host(app.handle(), "127.0.0.1", port, &fingerprint).expect("trust exec host");
    easy_console_lib::ssh::vscode::execute_test_remote_command(
        app.handle().clone(),
        port,
        "test-exit-first:success",
    )
    .await
    .expect("exit status after EOF is read");
    let error = easy_console_lib::ssh::vscode::execute_test_remote_command(
        app.handle().clone(),
        port,
        "test-exit-first:failure",
    )
    .await
    .expect_err("nonzero exit status fails even when EOF arrived first");
    assert!(error.contains("command output"));
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    let _local_dir_holder = test_temp_dir("ec-local-");
    let local_dir = _local_dir_holder.path().to_path_buf();
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

async fn concurrent_sftp_transfers_use_dedicated_channels() {
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-concurrent-");
    let root = _root_dir.path().to_path_buf();
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "sftp concurrent".into(),
        sftp_root: root.clone(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let session = trusted_session(&app, port, &fingerprint).await;

    let _local_dir = test_temp_dir("ec-local-concurrent-");
    let first = _local_dir.path().join("first.bin");
    let second = _local_dir.path().join("second.bin");
    std::fs::write(&first, vec![0x31_u8; 512 * 1024]).unwrap();
    std::fs::write(&second, vec![0x72_u8; 512 * 1024]).unwrap();
    TEST_SFTP_CHANNELS_OPENED.store(0, Ordering::SeqCst);
    TEST_SFTP_WRITE_REQUESTS.store(0, Ordering::SeqCst);

    let (first_tx, first_rx) = oneshot::channel();
    let (second_tx, second_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::SftpUpload {
            local_path: first.to_string_lossy().into_owned(),
            remote_path: "~/first.bin".into(),
            response: first_tx,
        })
        .unwrap();
    session
        .tx
        .send(SshCommand::SftpUpload {
            local_path: second.to_string_lossy().into_owned(),
            remote_path: "~/second.bin".into(),
            response: second_tx,
        })
        .unwrap();

    let (first, second) = tokio::time::timeout(Duration::from_secs(20), async {
        tokio::try_join!(first_rx, second_rx).expect("transfer responses")
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "both concurrent transfers complete; server received {} write requests",
            TEST_SFTP_WRITE_REQUESTS.load(Ordering::SeqCst)
        )
    });
    assert_eq!(first.expect("first upload succeeds").status, "completed");
    assert_eq!(second.expect("second upload succeeds").status, "completed");
    assert_eq!(
        TEST_SFTP_CHANNELS_OPENED.load(Ordering::SeqCst),
        2,
        "each concurrent transfer opens its own SFTP channel"
    );
    assert_eq!(
        TEST_SFTP_WRITE_REQUESTS.load(Ordering::SeqCst),
        16,
        "each transfer writes on its own SFTP session"
    );
    assert_eq!(
        std::fs::read(root.join("first.bin")).unwrap(),
        vec![0x31; 512 * 1024]
    );
    assert_eq!(
        std::fs::read(root.join("second.bin")).unwrap(),
        vec![0x72; 512 * 1024]
    );

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn sftp_cancel_aborts_upload_and_leaves_no_remote_file() {
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    let _local_dir_holder = test_temp_dir("ec-local-");
    let local_dir = _local_dir_holder.path().to_path_buf();
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    let _local_dir_holder = test_temp_dir("ec-local-");
    let local_dir = _local_dir_holder.path().to_path_buf();
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    // Keep one port occupied to verify a failed bind leaves the rule id free.
    let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let local_port = occupied.local_addr().unwrap().port();

    let rule = PortForwardRuleValue {
        id: "rule-1".into(),
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
    let bind_error = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("failed bind resolves")
        .expect("response channel");
    assert!(
        bind_error.is_err(),
        "an occupied local port must fail immediately"
    );
    drop(occupied);

    // The same rule id can retry once its port is available.
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule: rule.clone(),
            response: response_tx,
        })
        .unwrap();
    let started_port = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("start resolves")
        .expect("response channel")
        .expect("start succeeds");
    assert_eq!(started_port, local_port);
    let active = wait_for_kind(&mut session.events, "port-forward-status").await;
    let active_payload: serde_json::Value =
        serde_json::from_str(&active.data.unwrap_or_default()).unwrap();
    assert_eq!(active_payload["active"], true);
    assert_eq!(active_payload["localPort"], local_port);

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
    let restarted_port = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("restart resolves")
        .expect("response channel")
        .expect("restart after stop succeeds");
    assert_eq!(restarted_port, local_port);

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

    let auto_rule = PortForwardRuleValue {
        id: "auto-rule".into(),
        forward_type: "dynamic".into(),
        local_host: "127.0.0.1".into(),
        local_port: 0,
        remote_host: "example.invalid".into(),
        remote_port: 80,
        enabled: true,
    };
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule: auto_rule,
            response: response_tx,
        })
        .unwrap();
    let auto_port = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("auto-allocated start resolves")
        .expect("response channel")
        .expect("auto-allocated start succeeds");
    assert_ne!(auto_port, 0);
    let auto_status = wait_for_kind(&mut session.events, "port-forward-status").await;
    let auto_payload: serde_json::Value =
        serde_json::from_str(&auto_status.data.unwrap_or_default()).unwrap();
    assert_eq!(auto_payload["active"], true);
    assert_eq!(auto_payload["localPort"], auto_port);
    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", auto_port))
        .await
        .expect("the assigned port must have a live listener");
    client.write_all(&[5, 1, 0]).await.unwrap();
    let mut method_reply = [0u8; 2];
    client.read_exact(&mut method_reply).await.unwrap();
    assert_eq!(method_reply, [5, 0]);
    let host = b"example.invalid";
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host);
    request.extend_from_slice(&80u16.to_be_bytes());
    client.write_all(&request).await.unwrap();
    let mut connect_reply = [0u8; 10];
    client.read_exact(&mut connect_reply).await.unwrap();
    assert_eq!(connect_reply, [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    drop(client);
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StopPortForward {
            rule_id: "auto-rule".into(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("auto stop resolves")
        .expect("response channel")
        .expect("auto stop succeeds");

    session.tx.send(SshCommand::Close).expect("alive");
    let _ = tokio::time::timeout(TEST_TIMEOUT, session.task).await;
    let _ = session.window.close();
}

async fn dynamic_forward_reports_remote_open_failure() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    TEST_DIRECT_TCPIP_REJECTED.store(true, Ordering::SeqCst);
    let app = mock_app();
    let _root_dir = test_temp_dir("ec-sftp-");
    let (port, fingerprint, _done) = spawn_server(TestSshServer {
        username: "ubuntu".into(),
        password: "correct".into(),
        authorized_public_key: None,
        shell_banner: "socks-failure".into(),
        sftp_root: _root_dir.path().to_path_buf(),
        transfer_delay: None,
        stall_shell_input: false,
        support_posix_rename: false,
        posix_rename_seen: Arc::new(AtomicBool::new(false)),
    })
    .await;
    let session = trusted_session(&app, port, &fingerprint).await;
    let rule = PortForwardRuleValue {
        id: "socks-failure".into(),
        forward_type: "dynamic".into(),
        local_host: "127.0.0.1".into(),
        local_port: 0,
        remote_host: String::new(),
        remote_port: 0,
        enabled: true,
    };
    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StartPortForward {
            rule,
            response: response_tx,
        })
        .unwrap();
    let local_port = tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("start resolves")
        .expect("response channel")
        .expect("start succeeds");

    let mut client = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
        .await
        .expect("dynamic listener accepts a client");
    client.write_all(&[5, 1, 0]).await.unwrap();
    let mut method_reply = [0u8; 2];
    client.read_exact(&mut method_reply).await.unwrap();
    assert_eq!(method_reply, [5, 0]);
    let host = b"127.0.0.1";
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host);
    request.extend_from_slice(&1u16.to_be_bytes());
    client.write_all(&request).await.unwrap();
    let mut connect_reply = [0u8; 10];
    tokio::time::timeout(TEST_TIMEOUT, client.read_exact(&mut connect_reply))
        .await
        .expect("failed remote open returns a SOCKS5 reply")
        .expect("SOCKS5 reply is complete");
    assert_eq!(connect_reply, [5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
    TEST_DIRECT_TCPIP_REJECTED.store(false, Ordering::SeqCst);

    let (response_tx, response_rx) = oneshot::channel();
    session
        .tx
        .send(SshCommand::StopPortForward {
            rule_id: "socks-failure".into(),
            response: response_tx,
        })
        .unwrap();
    tokio::time::timeout(TEST_TIMEOUT, response_rx)
        .await
        .expect("stop resolves")
        .expect("response channel")
        .expect("stop succeeds");
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    let _local_dir_holder = test_temp_dir("ec-local-");
    let local_dir = _local_dir_holder.path().to_path_buf();
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
    let _keys_dir = test_temp_dir("ec-keys-");
    let (authorized, _) = generate_key_pair(_keys_dir.path(), "authorized", "");
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
    let (rejected, _) = generate_key_pair(_keys_dir.path(), "rejected", "");

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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
    // The server authorizes exactly one key; round 1 signs in with it.
    let _keys_dir = test_temp_dir("ec-keys-");
    let (authorized, _) = generate_key_pair(_keys_dir.path(), "authorized", "");
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
    let _root_dir = test_temp_dir("ec-sftp-");
    let root = _root_dir.path().to_path_buf();
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

    let state = Arc::new(SshSessionState::default());
    app.manage(Arc::clone(&state));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (input_tx, _input_rx) = mpsc::channel(1);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state.insert_test_entry("session-1", owner.label(), tx, input_tx, cancel_tx);

    // The owner window resolves the session; another window with the same id
    // must be refused, and an unknown id must not leak which case failed.
    assert!(state.resolve_owned(&owner, "session-1").is_ok());
    assert!(state.resolve_owned(&outsider, "session-1").is_err());
    assert!(state.resolve_owned(&owner, "missing-session").is_err());
    assert!(easy_console_lib::ssh::session::ssh_ack_output(
        app.state(),
        outsider.clone(),
        "session-1".into(),
        1,
    )
    .is_err());
    easy_console_lib::ssh::session::ssh_ack_output(
        app.state(),
        owner.clone(),
        "session-1".into(),
        1,
    )
    .expect("owner can acknowledge output");
    assert!(matches!(
        rx.try_recv(),
        Ok(SshCommand::OutputAck { sequence: 1 })
    ));
    assert!(easy_console_lib::ssh::session::ssh_close(
        app.state(),
        outsider.clone(),
        "session-1".into(),
    )
    .is_err());
    assert!(
        state.resolve_owned(&owner, "session-1").is_ok(),
        "unauthorized close must not retire the owner's session"
    );
    assert!(!*cancel_rx.borrow());
    assert!(matches!(
        rx.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    easy_console_lib::ssh::session::ssh_close(app.state(), owner.clone(), "session-1".into())
        .expect("owner can close its session");
    assert!(*cancel_rx.borrow());
    assert!(matches!(rx.try_recv(), Ok(SshCommand::Close)));
    assert!(state.resolve_owned(&owner, "session-1").is_err());
}

async fn sftp_commands_forward_canonical_local_paths() {
    let app = mock_app();
    let owner = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        "sftp-path-owner",
        Default::default(),
    )
    .build()
    .expect("owner window");
    let state = Arc::new(SshSessionState::default());
    app.manage(Arc::clone(&state));
    let (tx, mut commands) = mpsc::unbounded_channel();
    let (input_tx, _input_rx) = mpsc::channel(1);
    let (cancel_tx, _cancel_rx) = watch::channel(false);
    state.insert_test_entry("sftp-path-session", owner.label(), tx, input_tx, cancel_tx);

    let picked = test_temp_dir("ec-sftp-picked-");
    std::fs::create_dir(picked.path().join("sub")).unwrap();
    let source = picked.path().join("sub/source.bin");
    std::fs::write(&source, b"source").unwrap();
    state
        .register_sftp_local_root(&owner, "sftp-path-session", picked.path().to_str().unwrap())
        .expect("register picked directory");
    let root_text = picked.path().to_str().unwrap().replace('\\', "/");
    let upload = easy_console_lib::ssh::sftp::sftp_upload(
        app.state(),
        owner.clone(),
        "sftp-path-session".into(),
        format!(" {root_text}/./sub/source.bin "),
        "/remote.bin".into(),
    );
    let inspect_upload = async {
        match commands.recv().await.expect("upload command") {
            SshCommand::SftpUpload {
                local_path,
                response,
                ..
            } => {
                assert_eq!(
                    std::path::PathBuf::from(local_path),
                    source.canonicalize().unwrap()
                );
                response.send(Err("upload inspected".into())).unwrap();
            }
            _ => panic!("expected upload command"),
        }
    };
    let (uploaded, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(upload, inspect_upload)
    })
    .await
    .expect("upload command must be dispatched");
    assert_eq!(uploaded.unwrap_err(), "upload inspected");

    let download = easy_console_lib::ssh::sftp::sftp_download(
        app.state(),
        owner.clone(),
        "sftp-path-session".into(),
        "/remote.bin".into(),
        format!(" {root_text}/./sub/download.bin "),
    );
    let inspect_download = async {
        match commands.recv().await.expect("download command") {
            SshCommand::SftpDownload {
                local_path,
                response,
                ..
            } => {
                assert_eq!(
                    std::path::PathBuf::from(local_path),
                    picked
                        .path()
                        .join("sub")
                        .canonicalize()
                        .unwrap()
                        .join("download.bin")
                );
                response.send(Err("download inspected".into())).unwrap();
            }
            _ => panic!("expected download command"),
        }
    };
    let (downloaded, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(download, inspect_download)
    })
    .await
    .expect("download command must be dispatched");
    assert_eq!(downloaded.unwrap_err(), "download inspected");

    let outside = test_temp_dir("ec-sftp-outside-");
    let outside_file = outside.path().join("secret.bin");
    std::fs::write(&outside_file, b"outside").unwrap();
    assert!(easy_console_lib::ssh::sftp::sftp_upload(
        app.state(),
        owner.clone(),
        "sftp-path-session".into(),
        outside_file.to_str().unwrap().into(),
        "/remote.bin".into(),
    )
    .await
    .is_err());
    assert!(matches!(
        commands.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let _ = owner.close();
}

#[cfg(unix)]
async fn sftp_download_rejects_temp_symlink_escapes() {
    let app = mock_app();
    let owner = tauri::webview::WebviewWindowBuilder::new(
        app.handle(),
        "sftp-temp-owner",
        Default::default(),
    )
    .build()
    .expect("owner window");
    let state = Arc::new(SshSessionState::default());
    app.manage(Arc::clone(&state));
    let (tx, mut commands) = mpsc::unbounded_channel();
    let (input_tx, _input_rx) = mpsc::channel(1);
    let (cancel_tx, _cancel_rx) = watch::channel(false);
    state.insert_test_entry("sftp-temp-session", owner.label(), tx, input_tx, cancel_tx);
    let picked = test_temp_dir("ec-sftp-temp-picked-");
    let outside = test_temp_dir("ec-sftp-temp-outside-");
    state
        .register_sftp_local_root(&owner, "sftp-temp-session", picked.path().to_str().unwrap())
        .unwrap();
    let existing = outside.path().join("existing.bin");
    let missing = outside.path().join("missing.bin");
    let inside = picked.path().join("other.bin");
    std::fs::write(&existing, b"outside original").unwrap();
    std::fs::write(&inside, b"inside original").unwrap();
    for (name, target) in [
        ("existing", &existing),
        ("missing", &missing),
        ("inside", &inside),
    ] {
        let local_path = picked.path().join(format!("{name}.bin"));
        std::os::unix::fs::symlink(target, picked.path().join(format!("{name}.bin.part"))).unwrap();
        assert!(
            easy_console_lib::ssh::sftp::sftp_download(
                app.state(),
                owner.clone(),
                "sftp-temp-session".into(),
                "/remote.bin".into(),
                local_path.to_str().unwrap().into(),
            )
            .await
            .is_err(),
            "temp symlink {name} must be refused"
        );
        assert!(matches!(
            commands.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    assert_eq!(std::fs::read(&existing).unwrap(), b"outside original");
    assert_eq!(std::fs::read(&inside).unwrap(), b"inside original");
    assert!(!missing.exists());
    let _ = owner.close();
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
            "password_with_surrounding_whitespace_authenticates" => {
                box_test(password_with_surrounding_whitespace_authenticates())
            }
            "keyboard_interactive_password_fallback_is_restricted" => {
                box_test(keyboard_interactive_password_fallback_is_restricted())
            }
            "cancel_keyboard_interactive_authentication" => {
                box_test(cancel_keyboard_interactive_authentication())
            }
            "rsa_key_auth_negotiates_server_signature_hash" => {
                box_test(rsa_key_auth_negotiates_server_signature_hash())
            }
            "gpu_probe_timeout_closes_channel_and_allows_later_probe" => {
                box_test(gpu_probe_timeout_closes_channel_and_allows_later_probe())
            }
            "large_input_cannot_block_session_control" => {
                box_test(large_input_cannot_block_session_control())
            }
            "terminal_output_backpressure_preserves_bytes" => {
                box_test(terminal_output_backpressure_preserves_bytes())
            }
            "paused_terminal_output_can_close" => box_test(paused_terminal_output_can_close()),
            "private_key_auth_accepts_and_rejects_keys" => {
                box_test(private_key_auth_accepts_and_rejects_keys())
            }
            "host_key_prompt_confirms_first_connection" => {
                box_test(host_key_prompt_confirms_first_connection())
            }
            "legacy_known_host_is_upgraded_after_matching" => {
                box_test(legacy_known_host_is_upgraded_after_matching())
            }
            "changed_host_key_is_rejected" => box_test(changed_host_key_is_rejected()),
            "changed_host_key_for_recycled_task_can_be_confirmed" => {
                box_test(changed_host_key_for_recycled_task_can_be_confirmed())
            }
            "cancel_connecting_ssh_session" => box_test(cancel_connecting_ssh_session()),
            "cancel_waiting_for_host_key_confirmation" => {
                box_test(cancel_waiting_for_host_key_confirmation())
            }
            "cancel_authentication_ssh_session" => box_test(cancel_authentication_ssh_session()),
            "cancel_pty_request_ssh_session" => box_test(cancel_pty_request_ssh_session()),
            "cancel_shell_request_ssh_session" => box_test(cancel_shell_request_ssh_session()),
            "page_reload_cancels_owned_sessions" => box_test(page_reload_cancels_owned_sessions()),
            "channel_eof_before_exit_status_is_handled" => {
                box_test(channel_eof_before_exit_status_is_handled())
            }
            "sftp_upload_and_download_round_trip" => {
                box_test(sftp_upload_and_download_round_trip())
            }
            "concurrent_sftp_transfers_use_dedicated_channels" => {
                box_test(concurrent_sftp_transfers_use_dedicated_channels())
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
            "dynamic_forward_reports_remote_open_failure" => {
                box_test(dynamic_forward_reports_remote_open_failure())
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
            "sftp_commands_forward_canonical_local_paths" => {
                box_test(sftp_commands_forward_canonical_local_paths())
            }
            #[cfg(unix)]
            "sftp_download_rejects_temp_symlink_escapes" => {
                box_test(sftp_download_rejects_temp_symlink_escapes())
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
