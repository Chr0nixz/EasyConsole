# AGENTS.md

Guidance for coding agents working in this repository.

## Project

EasyConsole is a Tauri-first desktop control panel over the existing console at `http://116.172.93.164:28080/`, implemented with Vite + React + TypeScript and supported by Node-based CLI/MCP sidecars that share the same API wrappers.

Development priority is the packaged Tauri desktop app and its derived CLI/MCP tooling. The browser build is still maintained for renderer development, fast feedback, and portability, but product and architecture decisions should optimize for desktop workflows first.

The desktop shell is scaffolded under `src-tauri/`. Keep browser, Tauri, and Node behavior behind adapters so HTTP transport, token storage, WebSocket, notifications, SSH, file download, and external URL behavior can be swapped per runtime without leaking platform calls into page code.

Primary references:

- `api_documentation.md`: reconstructed API notes.
- `PRODUCT.md`: product intent and user workflow.
- `DESIGN.md`: visual system and UI principles.
- `I18N_GUIDELINES.md`: copywriting, bilingual terminology, and translation standards.
- `reference/original-console/`: downloaded original web console bundle and assets for behavior comparison.
- `skills/easy-console-ai/SKILL.md`: repository skill for AI agents using the CLI/MCP interface.

## Commands

Use `npm.cmd` on Windows PowerShell because `npm.ps1` may be blocked.

```powershell
npm.cmd install
Copy-Item .env.example .env.local
npm.cmd run dev
npm.cmd run dev:tauri
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build
npm.cmd run build:desktop
npm.cmd run build:sidecars
npm.cmd run tauri:dev
npm.cmd run tauri:build
npm.cmd run ec -- --help
npm.cmd run ec:mcp
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Run these before handing off functional changes:

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Use `npm.cmd run build` for the web-only production build. Use `npm.cmd run build:desktop` for Tauri build inputs; it builds sidecars, typechecks the app, and runs Vite. Use `npm.cmd run tauri:build` when an actual desktop bundle or installer is required. When time is limited, prioritize desktop input build and Tauri shell checks over web-only verification.

`lint` runs with `--max-warnings=37`, which is a ratchet rather than a target. The number may only go down: when you remove warnings, lower it in the same commit. Never raise it to make a build pass -- fix the new warning instead. Remaining warnings are `react-hooks/set-state-in-effect`, `react-refresh/only-export-components`, `react-hooks/exhaustive-deps`, and `react-hooks/incompatible-library`.

For `react-refresh/only-export-components` in context files, follow the existing split used by `use-toast.ts` and `use-download-queue.ts`: contexts, hooks, and plain helpers live in a `use-*.ts` file, and the `*Provider` component stays in its own file. That removes the warning instead of suppressing it.

The production build may warn about a large JS chunk; that is currently acceptable unless the task is specifically about bundle splitting.

## Environment

Default API base:

```text
VITE_API_BASE_URL=http://116.172.93.164:28080/api
```

Monitor dashboard base:

```text
VITE_MONITOR_DASHBOARD_URL=http://116.172.93.164:33000/d/da7c4fef-70c7-43eb-8103-31b7d283ca9f/pod-board?orgId=1
```

WebSSH is derived from the API host:

```text
ws://host/ws/webssh?task_id={id}&cols={cols}&rows={rows}
```

Runtime settings can override both URLs locally from the Settings page and are stored through `src/lib/runtime.ts`. CLI/MCP tools use:

```text
EASY_CONSOLE_API_BASE_URL=http://116.172.93.164:28080/api
EASY_CONSOLE_MONITOR_DASHBOARD_URL=http://116.172.93.164:33000/d/da7c4fef-70c7-43eb-8103-31b7d283ca9f/pod-board?orgId=1
EASY_CONSOLE_TOKEN=Bearer ...
EASY_CONSOLE_CONFIG=D:\path\to\config.json
EASY_CONSOLE_ALLOW_INSECURE_HTTP=1
```

Packaged desktop builds currently allow remote cleartext `http://` / `ws://` (lab console). Settings still warn when remote HTTP is in use. Production and externally reachable environments should use `https://...` or a local secure tunnel (`http://127.0.0.1:...`, local reverse proxy / VPN tunnel); the plain-HTTP lab console is an explicitly accepted exception. CLI/MCP reject remote cleartext by default; opt in with `--allow-insecure-http` or `EASY_CONSOLE_ALLOW_INSECURE_HTTP=1` for lab use.

Do not commit real account credentials, tokens, or live test secrets.

## Release identity and compatibility

The following production identity values are fixed for 1.x. Do not change them as routine cleanup; changing them can disconnect installed clients from their data, keychain, deep links or updates. Isolated acceptance builds may continue to use a separate test identifier.

- App identifier: `com.easyconsole.desktop`; default keychain service: `easy-console`. Keep existing app-data paths and sidecar path resolution compatible.
- Deep link scheme: `easyconsole://`.
- Updater endpoint: `https://github.com/Chr0nixz/EasyConsole/releases/latest/download/latest.json`.
- Updater public key in `src-tauri/tauri.conf.json`: `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIyNjBFRTlCRkIwQzAwREQKUldUZEFBejdtKzVnSW1UYWpiOWVnYWFhV2hxN2daWGJnaWpsVVA4bG55RXFlcTJJQ3Vya1VGQmIK`. Never replace it without a separately verified migration for installed clients.
- Android release application ID: `com.easyconsole.desktop`; debug uses `.debug`. Production signing-certificate identity and offline signing-key backup verification remain release gates; do not infer them from debug builds.
- Local storage, backups and the shared directory-lock protocol follow [LOCAL_DATA_FORMATS.md](LOCAL_DATA_FORMATS.md). 1.x changes must preserve forward migration and old backup import; never silently overwrite an unknown format.
- CLI/MCP compatibility follows [CLI_MCP_CONTRACT.md](CLI_MCP_CONTRACT.md). Keep both `easy-console-cli` and `easy-console-mcp` entrypoints for 1.x; deprecate published command/tool names before removal in 2.0. Preserve stable JSON envelopes, required arguments and MCP resource URIs. All requested credential/file/record/remote writes are dry-run unless CLI `--yes` or MCP `confirm: true` is supplied.

## Architecture

- `src/lib/transport-security.ts`: URL transport classification; packaged app does not block remote cleartext by default (CLI/MCP still opt-in).
- `src/lib/types.ts`: shared API and runtime types. Keep backend fields tolerant with `UnknownRecord` intersections when the live API is not fully verified.
- `src/lib/api-client.ts`: generic HTTP client, envelope unwrap, auth header injection, HTTP/business error mapping.
- `src/lib/api-factory.ts`: typed endpoint wrappers grouped by domain: auth, instance/task, image, storage, resource/price. Reused by web, CLI, and MCP.
- `src/lib/api.ts`: browser/Tauri singleton API client and runtime base URL setter.
- `src/lib/runtime.ts`: browser/Tauri runtime adapter for storage, fetch, WebSocket, notifications, clipboard, external links, and desktop SSH commands.
- `src/lib/app-settings.ts`: local runtime URL and notification preference settings.
- `src/lib/i18n.tsx`: in-app `zh-CN`/`en-US` dictionary, language persistence, and imperative `i18nText` helper. Also pushes the active locale to the native side through `set_locale`.
- `src-tauri/src/i18n.rs`: native locale flag, driven by the `trf!` macro in `lib.rs` that localizes Rust-produced strings.
- `tools/easy-console/locale.ts`: CLI/MCP locale bootstrap (`--lang` → `EASY_CONSOLE_LANG` → system locale → English).
- `tools/eslint-rules/no-bare-cjk.mjs`: ESLint rule that rejects hardcoded CJK text outside the localization helpers. See the Language section of DESIGN.md for which mechanism to use.
- `src/lib/run-logs.ts`: local operation log model for web, Tauri, CLI, and MCP channels.
- `src/lib/execution-ledger.ts`: local audit ledger for scheduled-task executions (trigger, account, remote task ID, outcome), with manual resolution of uncertain remote results from the scheduled tasks page.
- `src/lib/batch-runner.ts`: shared sequential batch engine (per-item outcomes, continue-on-error, progress, abort, failed-subset retry) reused by the UI and CLI/MCP.
- `src/lib/change-list.ts`: local change list for finished batch operations (action, trigger, account, per-item outcomes, `retryOf` linkage), rendered on the tasks page and exportable as JSON/CSV/Markdown.
- `src/components/batch/`: batch operation UI (impact-list preview, per-item result dialog with export, collapsible recent-batch history panel) and the `useBatchOperation` orchestration hook.
- `src/lib/task-templates.ts`: local instance template persistence and batch payload generation.
- `src/lib/scheduled-tasks.ts`: local scheduled task persistence and due-state helpers.
- `src/lib/task-list-query.ts` and `src/lib/task-search.ts`: task list URL query state and client-side search ranking.
- `src/lib/ssh-info.ts`: task SSH field extraction and normalized connection request mapping.
- `src/lib/upload-queue.ts`: upload queue state helpers for storage uploads.
- `src/lib/webssh.ts`: WebSSH URL and message formatting.
- `src/lib/overlay-stack.ts`: open-overlay stack; new dialogs, menus, and popovers that listen for Escape/Tab on `document` register with `useOverlay` and gate their keys with `claimOverlayKey`.
- `src/lib/download.ts`: browser download helper boundary.
- `src/lib/monitor-dashboard.ts`: Grafana monitor URL generation for task rows.
- `src/pages/*`: route pages.
- `src/components/*`: shared UI and feature dialogs.
- `tools/easy-console/*`: Node runtime, CLI, MCP server/tools, and sidecar build scripts.
- `src-tauri/src/lib.rs`: Tauri commands for app storage, external links, system terminal SSH, VS Code Remote-SSH setup, and in-app SSH sessions.
- `src-tauri/src/runtime_storage.rs` and `src-tauri/src/runtime_storage_lock.rs`: per-key runtime persistence, legacy JSON migration, per-key backups/tombstones, disk-backed CAS, and the cross-process `.lock` directory protocol shared with Node sidecars.
- `tools/easy-console/local-data-store.ts`: Node implementation of the Tauri per-key store, lock protocol, legacy CLI JSON migration, and separate local credential storage. CLI/MCP use the desktop app-data path by default; `EASY_CONSOLE_LOCAL_DATA_PATH` overrides the shared store anchor.

Avoid Node-only APIs in renderer code. If a feature needs platform behavior, design the Tauri command/runtime boundary first, then add browser and Node fallbacks only when they are useful and clean. Do not call browser, Tauri, or Node globals directly from page code.

## API Rules

- API envelopes normally look like `{ code, msg/message, data }`; `code !== 0` is a business error.
- Treat HTTP `401` and business code `10000` as login expiry.
- Preserve raw JSON/debug views where request or response shape is inferred rather than proven.
- Login posts to `/user/token` with a trimmed username and SHA-256 hex password.
- Tokens are normalized to `Bearer ...` before use.
- Blob endpoints must request `responseType: "blob"` and avoid envelope unwrap when the API returns raw binary.
- Storage chunk upload uses `Content-Range: bytes start-end/total`, then `/storage/chunked_upload_complete` with an MD5. Preserve the 0B upload fallback and post-upload listing check.
- WebSSH input sends `{ status: 0, data }`; resize sends `{ status: 1, cols, rows }`.
- Task monitor links use the Grafana dashboard URL and set `var-pod`; prefer `task.description`, then `name`, `task_name`, `task_id`, `id`.
- CLI mutations are dry-run by default and require `--yes`. MCP mutations require `confirm: true`.
- Task logs and remote storage text reads in CLI/MCP are byte-limited by default and should return truncation metadata.

## Current Field Notes

- Dashboard summary supports live fields such as `run_task_count`, `pending_task_count`, `run_time`, and `cost_map`.
- Task release condition may be spelled `releace_conditions` by the backend. Preserve that spelling in types and mapping.
- Release condition display:
  - `1`: manual release
  - `2`: timed release
  - `3`: release after task ends
- Task status and release condition should be displayed as colored badges with text, not color-only state.
- Task tables support column visibility settings; keep actions always visible.
- The app has protected routes for dashboard, task instances, scheduled tasks, instance templates, storage, images, run logs, and settings.
- Saved accounts store normalized tokens, user display metadata, and (when the user opts in via "Remember password") an AES-GCM ciphertext of the password. The plaintext password is never persisted; on Tauri the ciphertext lives in the OS keychain via secureStorage, and on web it lives in localStorage (obfuscation-grade only). Use `encryptPassword`/`decryptPassword` from `src/lib/password-crypto.ts` to round-trip the password field. `loginSaved` silently re-logs in with the stored password when the saved token has expired; accounts without a stored password fall back to the password form.
- Runtime URL settings affect login checks, task/image/storage requests, monitor links, and WebSSH URLs.
- Task templates and scheduled tasks are local runtime data, not backend entities. Templates can generate up to 50 task payloads.
- Run logs are local, pruned by count and age, and redact sensitive metadata keys.
- Important task status changes can trigger app toasts or system notifications for success, failure, and abnormal states.
- Desktop SSH supports in-app SSH via `russh`, opening a system terminal, and VS Code Remote-SSH setup. The web app only exposes copyable SSH details and WebSSH.
- Tauri and CLI/MCP runtime storage use per-key files under app data's `runtime-storage.d/`, with atomic writes, per-key backups, CAS, and a shared cross-process `.lock` protocol. Old `runtime-storage.json` and CLI `local-data.json` files are retained as migration snapshots; CLI credentials stay outside the shared store. Browser localStorage remains the fallback on command failures.
- Tauri uses `HashRouter`; the web build uses `BrowserRouter`.
- Desktop parity is more important than browser parity for new workflows. Browser behavior may be read-only, degraded, or hidden when there is no honest equivalent for a desktop capability.

## UI Guidelines

- Product UI is Chinese-first and can switch to English from the shell.
- Keep the interface operational and dense: side navigation, compact top/account area, tables, dialogs, breadcrumbs, tabs, and inline states.
- Use restrained light theme from `DESIGN.md`; avoid marketing landing pages, decorative hero sections, nested cards, and large empty visual treatments.
- Use `lucide-react` icons for icon buttons when possible.
- Every loading, empty, error, unauthorized, permission-denied, upload, and disconnect state should be clear and actionable.
- Keep keyboard focus visible and avoid color-only status communication.
- Keep desktop-only actions hidden or clearly disabled in web runtime. Do not imply that web can open local SSH sessions directly.
- Prefer UX copy and defaults that describe the desktop app as the main product; mention browser behavior only where it affects the current runtime.

## Testing Guidance

Add focused tests for shared behavior and API adapters:

- envelope parsing and business error mapping
- auth header injection and token normalization
- password hashing behavior
- saved-password encryption/decryption round-trip and malformed-payload rejection
- app settings parsing and runtime URL updates
- saved accounts and token-only account persistence
- blob downloads
- storage chunk range headers
- upload queue behavior
- WebSSH URL/message formatting
- SSH field extraction and desktop connection request mapping
- monitor dashboard URL formatting
- task list query serialization and search ranking
- task templates, scheduled tasks, run logs, and notification transitions
- i18n persistence, language switching, and native locale sync
- keyboard/focus behavior for dialogs and menus

For live validation, use a local test account only and never commit credentials. Validate login, userinfo, task list, safe task creation path, logs, terminal, storage upload/download/delete, and image list against the real API before marking uncertain flows complete.

For desktop changes, also run `cargo check --manifest-path src-tauri/Cargo.toml`. For sidecar/packaging changes, run `npm.cmd run build:sidecars` or `npm.cmd run build:desktop` as appropriate.

## Editing Notes

- Do not edit `node_modules/`, `dist/`, or Vite log files unless the user explicitly asks.
- Do not edit generated `build/`, `src-tauri/binaries/`, or packaged sidecar outputs unless the user explicitly asks.
- Keep changes scoped to the requested workflow.
- Prefer existing local components and helpers before introducing new abstractions.
- When adding API fields from live responses, type them narrowly when stable and preserve raw access for uncertain fields.
- Use `rg` for code search.
- Use `apply_patch` for manual file edits.
