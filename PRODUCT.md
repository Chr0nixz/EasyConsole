# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Register

product

## Users

A small team of Chinese-speaking researchers and operators who rent GPU container instances on the same compute platform and share EasyConsole among themselves. EasyConsole is an unofficial client: the team has no affiliation with the platform and no control over its backend. Users work in focused desk sessions on the Tauri desktop app, often comparing task status, storage paths, logs, terminal output, templates, cost, and local operation history; away from the desk they use the Android companion to check on running instances and react to reminders. Scripts and AI agents act for the same users through the CLI/MCP sidecars. The browser build is primarily a renderer development and fallback surface.

## Product Purpose

EasyConsole provides a desktop-first control panel for the existing remote API at `http://116.172.93.164:28080/`. Success means a user can log in from the packaged app, understand current task health and spend, create or manage instances, reuse task templates and resource presets, schedule deferred creations, open logs and terminal sessions, move files, manage images, and review operation history without returning to the original panel for daily work, and without paying for GPUs nobody is using.

## Positioning

The primary claim is that the daily instance loop moves out of a browser tab and onto a desktop workstation. Creating or cloning an instance, watching it start, opening a terminal or VS Code on it, moving files, reading logs, and releasing it all happen in one native app: in-app SSH with SFTP and port forwarding that survives page navigation, system-terminal and VS Code Remote-SSH handoff, system notifications and a tray presence, and local templates and scheduled creations that run on the user's own machine.

Two supporting mechanisms build on that desktop presence:

- Spend guardrails: idle-GPU detection sampled through the user's own SSH session, reminders before a timed release with one-step extension, and batch operations whose per-item outcomes are verified before a retry is offered.
- Safe automation: the CLI and MCP server share the app's API wrappers, and every mutation is dry-run by default until explicitly confirmed, so a script or AI agent can be handed the same workflows.

The original web console cannot truthfully offer these, because each depends on a local process with SSH access, OS integration, and local state.

## Operating Context

- Desktop sessions are the main scene. Windows is the most exercised platform: it alone has the Task Scheduler wake fallback for scheduled creations; other desktop systems rely on launch-at-login and the tray.
- The backend is a lab console reachable only over plain HTTP. The desktop and web app accept remote `http://` as an explicit lab exception and keep a visible warning in Settings; the CLI/MCP refuse it unless the user opts in.
- Several accounts can be saved and switched. Queries, auth state, SSH defaults, and local automation are scoped to the account that owns them.
- The Android app runs the same renderer in a compact layout with a bottom bar and in-app updates. It is a companion: check status, receive reminders, release or extend an instance, and reach a terminal in an emergency. Heavy work goes back to the desktop.
- CLI/MCP keep their own config (`%USERPROFILE%\.easy-console\config.json` by default) and their own local storage; desktop templates and presets reach them only through export and import.

## Current Product Surfaces

- Desktop app: the primary surface, using the React interface inside Tauri plus desktop storage, OS keychain, system notifications, tray, launch-at-login, external URL opening, in-app SSH, system terminal SSH, and VS Code Remote-SSH setup.
- Android app: a companion surface on the same renderer, for monitoring and quick actions rather than full desktop parity.
- CLI/MCP: derived sidecar surfaces for scripted and AI-facing access to task (including get/wait), batch, storage, image, resource, price, monitor URL, user info, and local run-log workflows, plus MCP resources for templates and resource presets.
- Web app: a supported renderer/debugging target with dashboard, task instances, scheduled tasks, instance templates, storage, images, run logs, settings, and login, but not the product priority.
- Local-only data: saved accounts, runtime URL settings, notification and idle-reminder preferences, scheduled tasks and their execution ledger, task templates, resource presets, the batch change list, and run logs.
- Backend data: user info, dashboard/statics, tasks, task logs, images, storage, resources, prices, and monitor target metadata.

## Capabilities and Constraints

- The backend belongs to the platform. Its API is reconstructed from the original console (`api_documentation.md`, `reference/original-console/`), so fields that are inferred rather than proven stay inspectable, and backend quirks such as the `releace_conditions` spelling are preserved rather than corrected.
- Creating an instance starts billing and EasyConsole cannot take it back. Releasing an instance stops billing and destroys container-local data. Both stay behind confirmations that state these consequences.
- Extending a timed release requires the backend to accept a PATCH edit. There is no PUT fallback, because the original console releases instances with PUT.
- Templates, resource presets, scheduled tasks, the execution ledger, the change list, and run logs are EasyConsole-side helpers, not backend entities. Scheduled creations run only while the desktop app is running or can be woken; CLI/MCP plans never run on their own.
- Idle auto-release is off by default. When enabled it acts only on a complete sampling window across every allocated GPU, with low CPU, zero network traffic, and the same account and API host; an uncertain outcome is never retried automatically.
- Terminal access exists only for running instances; logs exist from the moment an instance starts.
- Core terms follow `I18N_GUIDELINES.md`: 任务实例 / 实例 (instance), 释放实例 (release), 定时任务 (local scheduled creation), 实例模板 (instance template), 克隆 (clone).
- Not yet verified against the real backend: image update and delete, timed-release extension by PATCH, GPU sampling and monitor field units, and Windows wake across reboots and sleep. Candidate features under discussion are tracked in `PROJECT_REVIEW_2026-10-25.md` and are not commitments.

## Brand Commitments

- The product name is EasyConsole; its icon is `public/favicon.svg`.
- EasyConsole must not present itself as the platform's official client or borrow the platform's branding.
- The interface is Chinese-first with a full English mode; copy rules and terminology live in `I18N_GUIDELINES.md`.

## Brand Personality

Calm, precise, operational. The interface should feel like a trustworthy workstation: dense enough for repeated use, clear enough for uncertain API states, and restrained enough that status and errors stand out.

## Anti-references

Avoid marketing-page composition, oversized hero sections, decorative card grids, dashboard cliches, dark neon terminal styling as the whole product, and UI patterns that hide raw API uncertainty behind false confidence.

## Evidence on Hand

- `reference/original-console/`: the downloaded original web console bundle, for behavior comparison.
- `api_documentation.md`: reconstructed API notes.
- `tools/acceptance/`: a loopback mock console and an isolated Tauri acceptance configuration.
- Review and acceptance reports: `PROJECT_REVIEW_2026-10-24.md`, `PROJECT_REVIEW_2026-10-25.md`, `FEATURE_ACCEPTANCE_2026-10-27.md`, `MOBILE_REVIEW.md`, `AUDIT.md`, and `RELEASE_NOTES.md`.
- There is no user research, usage analytics, testimonial, or platform endorsement on hand. Future work must not invent them, and must not state pricing or cost figures beyond what the API returns.

## Design Principles

- Put the active task first: lists, filters, actions, logs, and terminal access should be one or two steps away.
- Make uncertain backend fields inspectable: preserve raw JSON/debug surfaces where the reconstructed API is not fully verified.
- Prefer desktop-capable runtime boundaries: isolate transport, storage, WebSocket, notification, SSH, external URL, and file behavior so Tauri leads the product while browser and Node runtimes stay portable.
- Keep controls familiar: standard tables, forms, drawers, tabs, breadcrumbs, and icon buttons should carry the workflow.
- Show operational state directly: loading, empty, unauthorized, permission denied, upload progress, and disconnect states need clear recovery paths.
- Make local automation visible: scheduled tasks, templates, notifications, and run logs should clearly show that they are EasyConsole-side helpers rather than backend scheduler state.
- Treat CLI/MCP as extensions of the desktop workflow: they should share authentication rules, dry-run defaults, run logs, and API behavior with the app.
- Guard spend without acting behind the user's back: surface idle and expiring instances early, keep automatic releases opt-in and conservative, and never retry an action whose remote outcome is unknown.

## Accessibility & Inclusion

Target WCAG AA contrast, keyboard-accessible controls, visible focus states, Chinese labels, reduced decorative motion, and status text that is not color-only. On the Android companion, controls need touch-sized targets and must keep working with the soft keyboard and system back gesture.
