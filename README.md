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

## AI and CLI Access

EasyConsole also exposes a Node-based CLI and MCP stdio server for AI agents and scripts. These entrypoints reuse the same API wrappers as the React app.

For AI agents that support skills, use the repository skill at:

```text
skills/easy-console-ai/SKILL.md
```

The skill explains when to prefer MCP versus CLI, how to authenticate, which operations are read-only, and how to handle risky mutations with `confirm: true` or `--yes`.

### Local credentials

The CLI reads configuration from `%USERPROFILE%\.easy-console\config.json` by default. Environment variables override the file:

```text
EASY_CONSOLE_API_BASE_URL=http://116.172.93.164:28080/api
EASY_CONSOLE_TOKEN=Bearer ...
EASY_CONSOLE_CONFIG=D:\path\to\config.json
```

Login stores a normalized bearer token in the local config file:

```powershell
"your-password" | npm.cmd run ec -- login --username your-name --password-stdin
```

Do not commit real credentials or generated config files.

### CLI commands

Use `npm.cmd run ec --` before the command arguments:

```powershell
npm.cmd run ec -- whoami
npm.cmd run ec -- --json task list
npm.cmd run ec -- --json task log 123
npm.cmd run ec -- --json storage ls /
npm.cmd run ec -- --json storage cat /path/to/file.txt
npm.cmd run ec -- --json image list
npm.cmd run ec -- --json resource list
npm.cmd run ec -- --json price list
npm.cmd run ec -- --json monitor-url 123
```

Mutation commands are dry-run by default. Pass `--yes` to execute:

```powershell
npm.cmd run ec -- --json task create --name demo --image-id 1 --cpu 4 --gpu 0 --memory 16
npm.cmd run ec -- --json task create --name demo --image-id 1 --cpu 4 --gpu 0 --memory 16 --yes
npm.cmd run ec -- --json task release 123 --yes
npm.cmd run ec -- --json task delete 123 --yes
npm.cmd run ec -- --json storage mkdir /demo --yes
npm.cmd run ec -- --json storage delete /demo --yes
npm.cmd run ec -- --json image set-default 1 --yes
```

All `--json` CLI output uses this shape:

```json
{ "ok": true, "data": {}, "error": null }
```

Task logs and remote text reads are truncated by default at `200000` bytes and return truncation metadata.

### MCP server

Start the MCP stdio server with:

```powershell
npm.cmd run ec:mcp
```

Available MCP tools include task list/log/create/release/delete, storage list/read/download/mkdir/delete, image list/set-default, user info, resources, prices, and monitor URL generation. Mutating MCP tools require `confirm: true`; otherwise they return a dry-run payload.

## Packaging

Windows desktop packaging produces the GUI app plus two AI/script sidecar executables:

```text
EasyConsole.exe
easy-console.exe
easy-console-mcp.exe
```

The sidecars are built from `tools/easy-console/` and copied into `src-tauri/binaries/` using Tauri's target-triple naming convention before the desktop bundle is created. The Tauri main binary is named `EasyConsole.exe` so it does not collide with the CLI sidecar `easy-console.exe`.

Build the sidecars only:

```powershell
npm.cmd run build:sidecars
```

The generated standalone tools are written to:

```text
build/sidecars/easy-console.exe
build/sidecars/easy-console-mcp.exe
```

The Tauri-ready sidecar binaries are written to:

```text
src-tauri/binaries/easy-console-x86_64-pc-windows-msvc.exe
src-tauri/binaries/easy-console-mcp-x86_64-pc-windows-msvc.exe
```

Build the full desktop package:

```powershell
npm.cmd run tauri:build
```

`tauri:build` runs Tauri, and Tauri's `beforeBuildCommand` runs:

```powershell
npm.cmd run build:desktop
```

That command builds both sidecars and the web app before bundling. The final installers and desktop binaries are under:

```text
src-tauri/target/release/EasyConsole.exe
src-tauri/target/release/bundle/
```

The MSI/NSIS installers include both sidecars. For portable/manual distribution, use `src-tauri/target/release/EasyConsole.exe` together with `build/sidecars/easy-console.exe` and `build/sidecars/easy-console-mcp.exe`.

Current sidecar packaging supports Windows x64. The sidecars are generated artifacts and are ignored by git.

## CI/CD

GitHub Actions workflows live in `.github/workflows/`:

- `ci.yml`: runs on pull requests and pushes to `main`/`master`; installs dependencies, runs typecheck, tool typecheck, lint, tests, sidecar build, web build, and uploads sidecar artifacts.
- `release.yml`: runs on `v*` tags or manual dispatch; verifies the project, builds the Windows Tauri desktop bundle, creates a draft GitHub release, and uploads sidecar plus portable desktop artifacts.

Create a release by pushing a version tag:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## Verification

Run these before shipping:

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:tools
npm.cmd run lint
npm.cmd run test
npm.cmd run build:sidecars
npm.cmd run build
```

Live verification still needs a real test account. Validate exact request and response fields for task creation, storage upload completion, and image actions before marking those flows complete.
