# Product

## Register

product

## Users

Chinese-speaking operators and researchers who need to launch, inspect, and manage remote compute tasks from a browser or a Tauri desktop shell. They work in focused sessions, often comparing task status, storage paths, logs, terminal output, templates, and local operation history.

## Product Purpose

EasyConsole provides a more usable control panel for the existing remote API at `http://116.172.93.164:28080/`. Success means a user can log in, understand current task health, create or manage instances, reuse task templates, schedule deferred creations, open logs and terminal sessions, move files, inspect images, and review operation history without returning to the original panel for daily work.

## Current Product Surfaces

- Web app: dashboard, task instances, scheduled tasks, instance templates, storage, images, run logs, settings, and login.
- Desktop app: the same React interface inside Tauri, plus desktop storage, system notifications, external URL opening, in-app SSH, system terminal SSH, and VS Code Remote-SSH setup.
- CLI/MCP: scripted and AI-facing access for task, storage, image, resource, price, monitor URL, user info, and local run-log workflows.
- Local-only data: saved accounts, runtime URL settings, notification preferences, scheduled tasks, task templates, and run logs.
- Backend data: user info, dashboard/statics, tasks, task logs, images, storage, resources, prices, and monitor target metadata.

## Brand Personality

Calm, precise, operational. The interface should feel like a trustworthy workstation: dense enough for repeated use, clear enough for uncertain API states, and restrained enough that status and errors stand out.

## Anti-references

Avoid marketing-page composition, oversized hero sections, decorative card grids, dashboard cliches, dark neon terminal styling as the whole product, and UI patterns that hide raw API uncertainty behind false confidence.

## Design Principles

- Put the active task first: lists, filters, actions, logs, and terminal access should be one or two steps away.
- Make uncertain backend fields inspectable: preserve raw JSON/debug surfaces where the reconstructed API is not fully verified.
- Prefer runtime boundaries: isolate transport, storage, WebSocket, notification, SSH, external URL, and file behavior so browser, Tauri, and Node runtimes stay portable.
- Keep controls familiar: standard tables, forms, drawers, tabs, breadcrumbs, and icon buttons should carry the workflow.
- Show operational state directly: loading, empty, unauthorized, permission denied, upload progress, and disconnect states need clear recovery paths.
- Make local automation visible: scheduled tasks, templates, notifications, and run logs should clearly show that they are EasyConsole-side helpers rather than backend scheduler state.

## Accessibility & Inclusion

Target WCAG AA contrast, keyboard-accessible controls, visible focus states, Chinese labels, reduced decorative motion, and status text that is not color-only.
