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
