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
