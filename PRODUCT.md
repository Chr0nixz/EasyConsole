# Product

## Register

product

## Users

Chinese-speaking operators and researchers who need to launch, inspect, and manage remote compute tasks from a browser today and from a Tauri desktop shell later. They work in focused sessions, often comparing task status, storage paths, logs, and terminal output.

## Product Purpose

EasyConsole provides a more usable control panel for the existing remote API at `http://116.172.93.164:28080/`. Success means a user can log in, understand current task health, create or manage instances, open logs and terminal sessions, and move files without returning to the original panel for daily work.

## Brand Personality

Calm, precise, operational. The interface should feel like a trustworthy workstation: dense enough for repeated use, clear enough for uncertain API states, and restrained enough that status and errors stand out.

## Anti-references

Avoid marketing-page composition, oversized hero sections, decorative card grids, dashboard cliches, dark neon terminal styling as the whole product, and UI patterns that hide raw API uncertainty behind false confidence.

## Design Principles

- Put the active task first: lists, filters, actions, logs, and terminal access should be one or two steps away.
- Make uncertain backend fields inspectable: preserve raw JSON/debug surfaces where the reconstructed API is not fully verified.
- Prefer Tauri-ready boundaries: isolate transport, storage, WebSocket, and file behavior so the renderer stays portable.
- Keep controls familiar: standard tables, forms, drawers, tabs, breadcrumbs, and icon buttons should carry the workflow.
- Show operational state directly: loading, empty, unauthorized, permission denied, upload progress, and disconnect states need clear recovery paths.

## Accessibility & Inclusion

Target WCAG AA contrast, keyboard-accessible controls, visible focus states, Chinese labels, reduced decorative motion, and status text that is not color-only.
