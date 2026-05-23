# EasyConsole

Tauri-ready React control panel for the existing web console API at `http://116.172.93.164:28080/`.

## Current Scope

- Login and user session recovery.
- Dashboard summaries with raw API response panels for field validation.
- Task table, task creation, logs, downloads, delete actions, and WebSSH terminal.
- Storage browser with mkdir, delete, download, and chunked upload.
- Image list, default action, and download.
- Runtime boundaries for future Tauri replacement: HTTP transport, token storage, WebSocket creation, and file download helpers.

## Setup

```powershell
npm.cmd install
Copy-Item .env.example .env.local
npm.cmd run dev
```

PowerShell may block `npm.ps1`; use `npm.cmd` on Windows.

## Environment

`VITE_API_BASE_URL` defaults to:

```text
http://116.172.93.164:28080/api
```

The WebSSH URL is derived from the same host:

```text
ws://host/ws/webssh?task_id={id}&cols={cols}&rows={rows}
```

## Verification

Run these before shipping:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run build
```

Live verification still needs a real test account. Validate exact request and response fields for task creation, storage upload completion, and image actions before marking those flows complete.
