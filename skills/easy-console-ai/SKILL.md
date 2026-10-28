---
name: easy-console-ai
description: Use when Codex or another AI agent needs to inspect or manage EasyConsole remote compute tasks, logs, storage, images, resources, prices, or monitor links through the project's CLI or MCP server. Trigger for requests such as checking task status, reading logs, listing storage, generating monitor URLs, creating/releasing/deleting tasks, or configuring AI access to EasyConsole.
---

# EasyConsole AI

Use EasyConsole through the structured MCP tools when available. Use the CLI when MCP is unavailable, when the user asks for a command, or when running inside this repository.

## Before Calling

- Never ask for or commit real passwords, tokens, or live test secrets.
- Prefer read-only operations first: list tasks, read logs, list storage, inspect images/resources/prices.
- Treat create, release, delete, mkdir, storage delete, and image default changes as mutating operations.
- Do not execute mutating operations unless the user explicitly asked for the action and the command/tool includes confirmation.
- Expect CLI JSON responses shaped as `{ "ok": boolean, "data": unknown, "error": unknown }`.

## Authentication

The toolchain reads credentials from local config or environment:

```text
EASY_CONSOLE_API_BASE_URL=http://116.172.93.164:28080/api
EASY_CONSOLE_TOKEN=Bearer ...
EASY_CONSOLE_CONFIG=D:\path\to\config.json
EASY_CONSOLE_ALLOW_INSECURE_HTTP=1
```

Remote cleartext HTTP is blocked unless you use HTTPS, `http://127.0.0.1` (local tunnel), or explicitly set `EASY_CONSOLE_ALLOW_INSECURE_HTTP=1` / CLI `--allow-insecure-http`.

Default config path on Windows:

```text
%USERPROFILE%\.easy-console\config.json
```

Login through stdin so passwords are not left in shell history:

```powershell
"password" | npm.cmd run ec -- login --username USERNAME --password-stdin
```

If the repo is packaged as desktop binaries, replace `npm.cmd run ec --` with `easy-console-cli.exe` on Windows (`easy-console-cli` on macOS/Linux).

## MCP Usage

Start the stdio server:

```powershell
npm.cmd run ec:mcp
```

Packaged deployments should point the AI client at `easy-console-mcp.exe`. The Tauri desktop package includes the GUI app plus these sidecars:

```text
EasyConsole.exe
easy-console-cli.exe
easy-console-mcp.exe
```

Use these tools by intent (all 54 registered tools):

- Tasks: `easyconsole_task_list`, `easyconsole_task_log`, `easyconsole_task_get`, `easyconsole_task_wait`, `easyconsole_task_create`, `easyconsole_task_update`, `easyconsole_task_release`, `easyconsole_task_release_batch`, `easyconsole_task_delete`, `easyconsole_task_delete_batch`, `easyconsole_task_check_name`, `easyconsole_task_download`.
- Storage: `easyconsole_storage_list`, `easyconsole_storage_read_text`, `easyconsole_storage_download`, `easyconsole_storage_upload`, `easyconsole_storage_mkdir`, `easyconsole_storage_delete`, `easyconsole_storage_info`.
- Images: `easyconsole_image_list`, `easyconsole_image_system`, `easyconsole_image_detail`, `easyconsole_image_set_default`, `easyconsole_image_update`, `easyconsole_image_delete`, `easyconsole_image_download`, `easyconsole_image_commit`.
- Account: `easyconsole_user_info`, `easyconsole_account_change_password`, `easyconsole_account_refresh_token`.
- Metadata: `easyconsole_resource_list`, `easyconsole_price_list`, `easyconsole_monitor_url`.
- Dashboard: `easyconsole_dashboard_stats`, `easyconsole_dashboard_cost`, `easyconsole_dashboard_cost_month`, `easyconsole_dashboard_monitor_index`.
- Templates: `easyconsole_template_list`, `easyconsole_template_create`, `easyconsole_template_update`, `easyconsole_template_apply`, `easyconsole_template_delete`.
- Schedules: `easyconsole_schedule_list`, `easyconsole_schedule_create`, `easyconsole_schedule_update`, `easyconsole_schedule_pause`, `easyconsole_schedule_resume`, `easyconsole_schedule_run`, `easyconsole_schedule_delete`.
- Backup: `easyconsole_backup_export`, `easyconsole_backup_import`.
- Run logs: `easyconsole_run_log_list`, `easyconsole_run_log_export`, `easyconsole_run_log_clear`.

Schedules are shared local records. The CLI/MCP sidecar never executes them automatically; `easyconsole_schedule_run` requires explicit confirmation and checks a known owner's account against the authenticated token. New sidecar plans have an unverified owner, so review them in the desktop app before enabling automatic execution.

Read-only MCP resources expose the shared local template and resource-preset collections:

- `easyconsole://local/templates` and `easyconsole://local/templates/{id}`.
- `easyconsole://local/resource-presets` and `easyconsole://local/resource-presets/{id}`.

Discover item URIs with `resources/list`; percent-encode item IDs. Resources read fresh shared local data without requiring remote authentication. Existing CLI/MCP `local-data.json` values are copied only into missing desktop keys and the source remains unchanged. CLI/MCP credentials stay in a separate local store and do not sync with the desktop keychain. The Windows scheduled wake-up operates on desktop plans only; plans created by CLI/MCP have an unverified owner and require review in the desktop app before automatic execution. Shared access requires the updated desktop and sidecars, since older desktop releases do not participate in the file lock.

For mutating MCP tools, pass `confirm: true` only after the user has clearly requested execution. Without it, the tool returns a dry-run payload.

## CLI Usage

Use PowerShell-friendly `npm.cmd` while working from the repo:

```powershell
npm.cmd run ec -- --json whoami
npm.cmd run ec -- --json task list
npm.cmd run ec -- --json task log 123
npm.cmd run ec -- --json task get 123
npm.cmd run ec -- --json task wait 123 --for 2 --timeout 300
npm.cmd run ec -- --json storage ls /
npm.cmd run ec -- --json storage cat /path/to/file.txt
npm.cmd run ec -- --json image list
npm.cmd run ec -- --json resource list
npm.cmd run ec -- --json price list
npm.cmd run ec -- --json monitor-url 123
```

Task status codes: 0 initializing, 1 queued, 2 running, 3 paused, 4 released, 5 exhausted, 6 succeeded, 7 failed, 8 abnormal. `task get` / `easyconsole_task_get` return the SSH endpoint without credentials; `task wait` polls until the target status, a failure status (early return), or the timeout — useful for create-then-connect flows.

Mutating CLI commands are dry-run by default. Add `--yes` only when executing an intentional change:

```powershell
npm.cmd run ec -- --json task create --name demo --image-id 1 --cpu 4 --gpu 0 --memory 16
npm.cmd run ec -- --json task create --name demo --image-id 1 --cpu 4 --gpu 0 --memory 16 --yes
npm.cmd run ec -- --json task release 123 --yes
npm.cmd run ec -- --json task delete 123 --yes
npm.cmd run ec -- --json storage mkdir /demo --yes
npm.cmd run ec -- --json storage delete /demo --yes
npm.cmd run ec -- --json image set-default 1 --yes
```

Task logs and remote text reads are truncated at `200000` bytes by default and include truncation metadata.

## Workflow

1. Confirm authentication using `whoami` or `easyconsole_user_info`.
2. Gather state with task/storage/image/resource read-only commands.
3. For user-facing answers, summarize important fields and mention truncation if present.
4. For risky operations, show the dry-run payload first unless the user already requested execution clearly.
5. After a confirmed mutation, re-run the relevant read-only command to verify current state.

## Failure Handling

- If `ok` is false or a tool returns an error object, surface `message`, `status`, `code`, and `kind` when present.
- If authentication expired, ask the user to refresh credentials or run login again.
- If live API shape is uncertain, preserve raw JSON details instead of inventing stable fields.
- Do not use WebSSH through this skill; first version supports task logs and monitor URLs, not interactive terminals.
