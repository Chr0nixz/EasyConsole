# AGENTS.md

Guidance for coding agents working in this repository.

## Project

EasyConsole is a Vite + React + TypeScript SPA for a more usable browser control panel over the existing console at `http://116.172.93.164:28080/`.

The app is intentionally Tauri-ready but does not scaffold Tauri yet. Keep browser-specific HTTP, token storage, WebSocket, and download behavior behind adapters so a future desktop shell can replace them.

Primary references:

- `api_documentation.md`: reconstructed API notes.
- `PRODUCT.md`: product intent and user workflow.
- `DESIGN.md`: visual system and UI principles.
- `reference/original-console/`: downloaded original web console bundle and assets for behavior comparison.

## Commands

Use `npm.cmd` on Windows PowerShell because `npm.ps1` may be blocked.

```powershell
npm.cmd install
Copy-Item .env.example .env.local
npm.cmd run dev
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

Run these before handing off functional changes:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

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

Do not commit real account credentials, tokens, or live test secrets.

## Architecture

- `src/lib/types.ts`: shared API and runtime types. Keep backend fields tolerant with `UnknownRecord` intersections when the live API is not fully verified.
- `src/lib/api-client.ts`: generic HTTP client, envelope unwrap, auth header injection, HTTP/business error mapping.
- `src/lib/api.ts`: typed endpoint wrappers grouped by domain: auth, instance/task, image, storage, resource/price.
- `src/lib/runtime.ts`: browser runtime adapter for storage, fetch, and WebSocket creation.
- `src/lib/webssh.ts`: WebSSH URL and message formatting.
- `src/lib/download.ts`: browser download helper boundary.
- `src/lib/monitor-dashboard.ts`: Grafana monitor URL generation for task rows.
- `src/pages/*`: route pages.
- `src/components/*`: shared UI and feature dialogs.

Avoid Node-only APIs in renderer code. If a feature needs platform behavior, add it to a runtime adapter rather than calling a browser or Node global directly from page code.

## API Rules

- API envelopes normally look like `{ code, msg/message, data }`; `code !== 0` is a business error.
- Treat HTTP `401` and business code `10000` as login expiry.
- Preserve raw JSON/debug views where request or response shape is inferred rather than proven.
- Login posts to `/user/token` with a trimmed username and SHA-256 hex password.
- Tokens are normalized to `Bearer ...` before use.
- Blob endpoints must request `responseType: "blob"` and avoid envelope unwrap when the API returns raw binary.
- Storage chunk upload uses `Content-Range: bytes start-end/total`, then `/storage/chunked_upload_complete`.
- WebSSH input sends `{ status: 0, data }`; resize sends `{ status: 1, cols, rows }`.
- Task monitor links use the Grafana dashboard URL and set `var-pod`; prefer `task.description`, then `name`, `task_name`, `task_id`, `id`.

## Current Field Notes

- Dashboard summary supports live fields such as `run_task_count`, `pending_task_count`, `run_time`, and `cost_map`.
- Task release condition may be spelled `releace_conditions` by the backend. Preserve that spelling in types and mapping.
- Release condition display:
  - `1`: manual release
  - `2`: timed release
  - `3`: release after task ends
- Task status and release condition should be displayed as colored badges with text, not color-only state.
- Task tables support column visibility settings; keep actions always visible.

## UI Guidelines

- Product UI is Chinese-first.
- Keep the interface operational and dense: side navigation, compact top/account area, tables, dialogs, breadcrumbs, tabs, and inline states.
- Use restrained light theme from `DESIGN.md`; avoid marketing landing pages, decorative hero sections, nested cards, and large empty visual treatments.
- Use `lucide-react` icons for icon buttons when possible.
- Every loading, empty, error, unauthorized, permission-denied, upload, and disconnect state should be clear and actionable.
- Keep keyboard focus visible and avoid color-only status communication.

## Testing Guidance

Add focused tests for shared behavior and API adapters:

- envelope parsing and business error mapping
- auth header injection and token normalization
- password hashing behavior
- blob downloads
- storage chunk range headers
- WebSSH URL/message formatting
- monitor dashboard URL formatting

For live validation, use a local test account only and never commit credentials. Validate login, userinfo, task list, safe task creation path, logs, terminal, storage upload/download/delete, and image list against the real API before marking uncertain flows complete.

## Editing Notes

- Do not edit `node_modules/`, `dist/`, or Vite log files unless the user explicitly asks.
- Keep changes scoped to the requested workflow.
- Prefer existing local components and helpers before introducing new abstractions.
- When adding API fields from live responses, type them narrowly when stable and preserve raw access for uncertain fields.
- Use `rg` for code search.
- Use `apply_patch` for manual file edits.
