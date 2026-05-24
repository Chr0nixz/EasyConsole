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
```

Run these before handing off functional changes:

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:desktop
cargo check --manifest-path src-tauri/Cargo.toml
```

Use `npm.cmd run build` for the web-only production build. Use `npm.cmd run build:desktop` for Tauri build inputs; it builds sidecars, typechecks the app, and runs Vite. Use `npm.cmd run tauri:build` when an actual desktop bundle or installer is required. When time is limited, prioritize desktop input build and Tauri shell checks over web-only verification.

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
```

Do not commit real account credentials, tokens, or live test secrets.

## Architecture

- `src/lib/types.ts`: shared API and runtime types. Keep backend fields tolerant with `UnknownRecord` intersections when the live API is not fully verified.
- `src/lib/api-client.ts`: generic HTTP client, envelope unwrap, auth header injection, HTTP/business error mapping.
- `src/lib/api-factory.ts`: typed endpoint wrappers grouped by domain: auth, instance/task, image, storage, resource/price. Reused by web, CLI, and MCP.
- `src/lib/api.ts`: browser/Tauri singleton API client and runtime base URL setter.
- `src/lib/runtime.ts`: browser/Tauri runtime adapter for storage, fetch, WebSocket, notifications, clipboard, external links, and desktop SSH commands.
- `src/lib/app-settings.ts`: local runtime URL and notification preference settings.
- `src/lib/i18n.tsx`: in-app `zh-CN`/`en-US` dictionary, language persistence, and imperative `i18nText` helper.
- `src/lib/run-logs.ts`: local operation log model for web, Tauri, CLI, and MCP channels.
- `src/lib/task-templates.ts`: local instance template persistence and batch payload generation.
- `src/lib/scheduled-tasks.ts`: local scheduled task persistence and due-state helpers.
- `src/lib/task-list-query.ts` and `src/lib/task-search.ts`: task list URL query state and client-side search ranking.
- `src/lib/ssh-info.ts`: task SSH field extraction and normalized connection request mapping.
- `src/lib/upload-queue.ts`: upload queue state helpers for storage uploads.
- `src/lib/webssh.ts`: WebSSH URL and message formatting.
- `src/lib/download.ts`: browser download helper boundary.
- `src/lib/monitor-dashboard.ts`: Grafana monitor URL generation for task rows.
- `src/pages/*`: route pages.
- `src/components/*`: shared UI and feature dialogs.
- `tools/easy-console/*`: Node runtime, CLI, MCP server/tools, and sidecar build scripts.
- `src-tauri/src/lib.rs`: Tauri commands for app storage, external links, system terminal SSH, VS Code Remote-SSH setup, and in-app SSH sessions.

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
- Saved accounts store normalized tokens and user display metadata only, not passwords.
- Runtime URL settings affect login checks, task/image/storage requests, monitor links, and WebSSH URLs.
- Task templates and scheduled tasks are local runtime data, not backend entities. Templates can generate up to 50 task payloads.
- Run logs are local, pruned by count and age, and redact sensitive metadata keys.
- Important task status changes can trigger app toasts or system notifications for success, failure, and abnormal states.
- Desktop SSH supports in-app SSH via `russh`, opening a system terminal, and VS Code Remote-SSH setup. The web app only exposes copyable SSH details and WebSSH.
- Tauri storage is persisted in app data through `runtime-storage.json`, with browser localStorage fallback on command failures.
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
- i18n persistence and language switching
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
