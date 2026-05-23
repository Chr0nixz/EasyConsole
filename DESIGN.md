# Design System

## Theme

Light product interface for operators working at a desk during normal development or lab sessions, where dense task data and file paths need scan-friendly contrast.

## Color

Use restrained, slightly warm neutrals with one blue accent for primary actions and selection. Semantic colors are reserved for task state, validation, and API failures.

- Background: `oklch(0.982 0.006 95)`
- Surface: `oklch(0.995 0.004 95)`
- Panel: `oklch(0.955 0.008 95)`
- Border: `oklch(0.86 0.012 95)`
- Text: `oklch(0.23 0.018 255)`
- Muted text: `oklch(0.48 0.018 255)`
- Accent: `oklch(0.54 0.145 250)`
- Success: `oklch(0.54 0.12 150)`
- Warning: `oklch(0.72 0.13 78)`
- Danger: `oklch(0.58 0.18 25)`

Semantic surfaces use paired soft backgrounds and ring colors, exposed as `app.*Soft` and `app.*Ring` tokens for badges, toasts, validation, selected rows, and API failure states. Code and terminal surfaces use `app.code*` and `app.terminal*` tokens so dark inspection panels remain intentional without leaking generic slate/sky palette classes into product UI.

## Typography

Use `Inter`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `system-ui`, and `sans-serif`. UI text uses fixed rem sizes with compact line-height. Monospace surfaces use `"JetBrains Mono"`, `"SFMono-Regular"`, Consolas, and monospace.

## Components

Controls use 8px or smaller radii, visible focus rings, restrained hover states, and consistent icon sizing. Use dense data tables, side navigation, top account/status bar, drawers for detail work, and inline empty/error states instead of decorative cards.

## Layout

Default app shell is a fixed-width left navigation with a flexible content area. Pages use full-width work surfaces, compact toolbars, and table-first layouts. Avoid nested cards and avoid wrapping every section in floating panels.

## Motion

Motion is limited to 150-200 ms state transitions for hover, focus, drawer open, and loading indicators. No decorative page-load animation.
