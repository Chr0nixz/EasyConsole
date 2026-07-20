# EasyConsole v0.4.6

Audit remediation release: safer task workflows, coordinated polling, richer command palette / CLI coverage, and SSH first-connect confirmation.

## Changes

- **Task navigation & shortcuts**: Dashboard and lists link to `/tasks/:id`; task table gains j/k row focus plus Enter / l / t / r actions; Web no longer duplicates “connection info” in More when it is already the primary action.
- **Command palette**: Matched tasks expand into detail, logs, terminal, and release actions (detail opens with `?tab=`).
- **Task snapshot coordination**: Shared `TASK_SNAPSHOT_QUERY_KEY` so Watcher / Detail / Templates share one poll path and invalidate together.
- **Create / schedule / templates**: Resource and price fields wired through create, edit, scheduled tasks, and templates.
- **Reliability**: Tauri storage writes are atomic; browser storage uses a mutex; scheduled-task load failures are caught; API clients refresh on arbitrary-method 401; notifications cover the full `fetchAllTasks` set.
- **SSH TOFU**: Unknown hosts prompt before writing known-host fingerprints; mismatches still reject with a clear Settings recovery path.
- **Performance & UX**: Task table virtualization, streaming MD5 for uploads, truncated task logs, Settings password change, and clearer web-only SSH copy (no WebSSH UI by product decision).
- **CLI / MCP**: Template create/update, schedule update/pause/resume with variable apply, and batch release.
- **Tests**: Page smoke coverage for Settings / Storage / Images, plus Rust known-host helpers.

---

# EasyConsole v0.4.5

Per-account settings with SSH default password, plus more reliable secure storage and session restore.

## Changes

- **Per-account settings**: App settings are stored independently per signed-in account. Switching accounts loads that account's runtime URLs, notifications, and SSH preferences.
- **SSH default password**: Settings gains a default password field. When the API omits SSH credentials, the app uses the account setting, then falls back to the login username.
- **Secure storage layering**: Keychain reads now consult the local fallback when the OS keychain returns empty (fixes Windows Credential Manager blob-size fallback losing saved accounts). Migration no longer deletes the plaintext copy after a fallback write.
- **Session restore UX**: Startup shows a restore spinner while remembered sessions / passwords are being restored, instead of flashing the login form.

---

# EasyConsole v0.4.4

Harden in-app SSH: fix Windows pop-out deadlock, event races, and credential/host-key edge cases.

## Changes

- **Fix SSH pop-out freeze**: Made `open_ssh_window` async so Windows WebView2 no longer deadlocks (white screen + frozen app). Same-label rebuild waits for the old window to close.
- **SSH event race**: Global `ssh-session-event` listener with early event buffering so status/error/output emitted before the frontend handler registers are no longer dropped.
- **Password mapping**: Stopped treating nested `user.username` as the SSH password when the API omits password fields.
- **Pop-out gate**: Added `supportsSshPopOut` (desktop-only); pop-out failures surface a toast instead of failing silently.
- **Known hosts errors**: Host-key IO failures and fingerprint mismatches now return clear Chinese error messages instead of a generic connection failure.
- **SOCKS5 IPv6**: Dynamic port-forward destinations use standard `Ipv6Addr` formatting.

---

# EasyConsole v0.3.9

Remember passwords for one-click saved-account sign-in, with automatic silent re-login after token expiry.

## Changes

- **Remember password**: Added a "Remember password" option on the login page. When enabled, the password is encrypted with AES-GCM (PBKDF2-derived key, per-account random salt/IV) and stored alongside the token in secure storage. The plaintext password is never persisted.
- **Silent re-login**: `loginSaved` now tries the saved token first; if it has expired and a stored password is available, the app automatically re-logs in with the decrypted password and refreshes both token and ciphertext — no password retyping required. Accounts without a stored password still fall back to the password form.
- **Password crypto module**: New `src/lib/password-crypto.ts` provides `encryptPassword`/`decryptPassword` with round-trip, randomness, unicode, and malformed-payload tests.
- **Login UX**: Added a "Remember password" checkbox (default on) to the password form; updated i18n copy and the saved-account note. Backward compatible with existing saved accounts.

---

# EasyConsole v0.3.8

Task detail page, encrypted backups, image commit queue, and CI reliability improvements.

## Changes

- **Task detail page**: New `TaskDetailPage` with tabbed views for logs, Grafana monitor, in-app SSH, and raw JSON data.
- **Encrypted backups**: Added backup/restore with PBKDF2 key derivation and AES-GCM encryption for local data portability.
- **Image commit queue**: Context provider for batching image commit operations with progress tracking.
- **Image favorites and resumable uploads**: Mark images as favorites; resume interrupted uploads from the last completed chunk.
- **Task recurrence**: Added cron, interval, and weekly recurrence support for scheduled tasks.
- **ErrorBoundary**: Crash recovery wrapper for route pages to prevent full-app blank screens on component errors.
- **MD5 web worker**: Off-thread file hashing for upload integrity checks, keeping the main thread responsive.
- **Local data store**: Shared data layer for CLI/MCP sidecars to read and write app-local state.
- **Desktop enhancements**: Added Tauri deep-link, global-shortcut, and keyring plugins. Added `recharts`, `react-virtual`, and xterm webgl/web-links addons.
- **CI: Linux build fix**: Added `libglib2.0-dev` to apt dependencies — `libgtk-3-dev` alone doesn't reliably pull `glib-2.0.pc` on GitHub runners.
- **CI: Android quality gates**: Added typecheck, lint, test, and cargo check steps to the Android CI workflow.

---

# EasyConsole v0.3.7

Android in-app update support and mobile UI improvements.

## Changes

- **Android in-app update**: Added mobile update checking via GitHub API. The app now detects new releases, downloads the matching APK (aarch64 or x86_64), and launches the system installer through a native `install_apk` Tauri command using JNI and FileProvider.
- **Mobile navigation**: Redesigned the sidebar for mobile with a compact bottom navigation bar (Dashboard, Tasks, Storage, Images) and a "More" overflow menu for secondary pages. Added online/offline status indicator.
- **Create task dialog**: Restructured the form with grouped sections (`FormSection`) and inline field validation (`FieldError`) for better usability.
- **Responsive tables**: Scheduled tasks and other pages now render card layouts on small screens instead of horizontally scrolling tables.
- **Android manifest**: Added `REQUEST_INSTALL_PACKAGES` permission for in-app APK installation.

---

# EasyConsole v0.3.6

This release improves the in-app SSH terminal on mobile and fixes CI pipeline issues for Android builds.

## Highlights

- **Mobile SSH virtual keyboard**: Added an on-screen key bar for Android tablets when using the in-app SSH terminal. It provides Esc, Tab, arrow keys, a sticky Ctrl key, and common shortcuts (Ctrl+C, Ctrl+Z, Ctrl+D, Ctrl+L), making command-line interaction on touch devices much easier.
- **Mobile SSH event handling**: Fixed the runtime guard that prevented SSH session events from being listened to on mobile. Mobile now uses the same Tauri event channel as desktop for in-app SSH.

## Changes

- **SSH terminal UX**: Added `termRef` to keep the terminal focused after tapping a virtual key, and wired Ctrl key combinations through the terminal's `onKey` handler so mobile users can send control sequences.
- **CI: workflow optimization**: Added caching, job timeouts, and a streamlined matrix strategy to reduce build times and improve reliability.
- **CI: Android NDK fixes**: Forced NDK 27 usage, removed Aliyun repository mirrors, and added verbose logging to diagnose Android cross-compilation issues.
- **CI: executable permissions**: Set the `gradlew` executable bit on Linux runners so Android builds can run the wrapper script.
- **Android debugging**: Added `android_logger`, WebView debugging, and Kotlin trace logs to help diagnose launch and runtime issues on Android.

---

# EasyConsole v0.3.5

Fix Android white screen caused by a logger conflict and missing webview window on mobile.

## Changes

- **Fix logger panic**: Removed `android_logger::init_once()` from `run()` — it conflicted with `tauri_plugin_log` (both try to set the global logger, causing a `SIGABRT` at Tauri `app.rs:1417`). `tauri_plugin_log` now handles log output on all platforms.
- **Plugin chain ordering**: Moved `tauri_plugin_log` registration from inside the `setup` closure into the main plugin chain, ensuring it initializes before any `log::info!` calls fire.
- **Mobile webview window**: Added explicit `WebviewWindowBuilder` on mobile — the generated Tauri config has an empty `windows[]` array, so no window was being created, resulting in a blank screen.
- **WebView DevTools**: `WebView.setWebContentsDebuggingEnabled(true)` retained in `MainActivity` for Chrome remote debugging during development.
- **Gradle Aliyun mirrors**: Added `maven.aliyun.com` repository mirrors to `build.gradle.kts` for faster dependency resolution from China.

---

# EasyConsole v0.3.4

Fix Android white screen on x86_64 emulators by building APKs for both ARM64 and x86_64.

## Changes

- **CI: dual-architecture Android builds**: Release and CI workflows now use a matrix strategy to build both `aarch64` (real devices) and `x86_64` (emulators) APKs. Previously, only `aarch64` was built, causing a white screen on x86_64 emulators (MuMu, etc.) because the Houdini ARM translation layer failed to load the native Rust library.
- **Per-target NDK environment**: Each matrix target gets its own CC, AR, and linker environment variables, with architecture-specific Cargo cache keys.

---

# EasyConsole v0.3.3

Fix Android white screen caused by blocked cleartext HTTP traffic.

## Changes

- **Android network security config**: Added `network_security_config.xml` allowing cleartext traffic to the API server (`116.172.93.164`). Without this, Android release builds block all `http://` connections, causing silent API failures and a blank screen on launch.

---

# EasyConsole v0.3.2

CI pipeline fixes and Android release signing support.

## Changes

- **CI: fix gen/android paths**: Corrected `gen/android` to `src-tauri/gen/android` in both release and android-ci workflows.
- **Android release signing**: Added `signingConfigs` block to `app/build.gradle.kts` that reads keystore from environment variables. CI decodes the keystore from a base64 GitHub secret at build time.
- **Graceful fallback**: When signing secrets are not configured, the build produces an unsigned APK with a warning instead of failing.

---

# EasyConsole v0.3.1

Maintenance release to fix the macOS x64 CI build failure.

## Changes

- **CI: macOS x64 runner migration**: Replaced deprecated `macos-13` runner with `macos-15-intel` in the release workflow. GitHub retired `macos-13` images in December 2025; the old runner caused DMG bundling failures due to `macos-latest` migrating to ARM64 (cross-compilation breaks Tauri's `bundle_dmg.sh`).

---

# EasyConsole v0.3.0

This release adds Android tablet support with in-app SSH, enabling tablet users to connect to task instances directly from the app.

## Highlights

- **Android tablet SSH**: In-app SSH terminal now works on Android tablets via `russh` compiled with NDK, sharing the same Rust SSH pipeline as desktop.
- **Runtime capability update**: `supportsInAppSsh` now returns `true` for both desktop and mobile runtimes; VS Code and system terminal remain desktop-only.
- **Android CI**: Added GitHub Actions workflow for Android APK builds on `aarch64` with NDK 27 cross-compilation.
- **Release pipeline**: Android APK is now included in the GitHub Release alongside desktop installers.

## Release Notes

After the GitHub Actions draft release is created, verify updater assets such as `latest.json` and signature files before publishing the release.
