# Design System

## Theme

Light desktop product interface for operators working at a desk during normal development or lab sessions, where dense task data, file paths, SSH actions, and local operation history need scan-friendly contrast.

## Color

Use restrained, slightly warm neutrals with one blue accent for primary actions and selection. Semantic colors are reserved for task state, validation, and API failures.

- Background: `oklch(0.982 0.006 95)`
- Surface: `oklch(0.995 0.004 95)`
- Panel: `oklch(0.955 0.008 95)`
- Border: `oklch(0.86 0.012 95)`
- Border (strong): `oklch(0.62 0.014 95)`
- Text: `oklch(0.23 0.018 255)`
- Muted text: `oklch(0.48 0.018 255)`
- On accent: `oklch(0.995 0.004 95)`
- Accent: `oklch(0.50 0.145 250)`
- Success: `oklch(0.45 0.12 150)`
- Warning: `oklch(0.46 0.12 78)`
- Danger: `oklch(0.50 0.18 25)`

Semantic surfaces use paired soft backgrounds and ring colors, exposed as `app.*Soft` and `app.*Ring` tokens for badges, toasts, validation, selected rows, and API failure states. Use `app.onAccent` for text and icons on saturated accent or danger fills. Borders are two-tier: `app.border` is the soft decorative boundary for panels, dividers, and table rules, while `app.borderStrong` is required wherever the boundary is the only cue identifying an interactive control (inputs, selects, textareas, secondary buttons), because `app.surface` and `app.bg` are near-identical and the soft border measures 1.51:1 there, below the 3:1 WCAG 1.4.11 non-text minimum. Sticky table action columns use named `shadow-stickyColumn*` shadows rather than arbitrary shadow values. Code and terminal surfaces use `app.code*` and `app.terminal*` tokens so dark inspection panels remain intentional without leaking generic slate/sky palette classes into product UI.

## Typography

Use `Inter`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `system-ui`, and `sans-serif`. UI text uses fixed rem sizes with compact line-height. Monospace surfaces use `"JetBrains Mono"`, `"SFMono-Regular"`, Consolas, and monospace.

## Components

Controls use 8px or smaller radii, visible focus rings, restrained hover states, and consistent icon sizing. Use dense data tables, side navigation, top account/status bar, drawers for detail work, and inline empty/error states instead of decorative cards.

Dialog and popover interactions must be keyboard-accessible, restore focus when closed, and keep destructive or long-running actions behind explicit confirmation. Desktop-only actions such as in-app SSH, system terminal, and VS Code are first-class desktop controls; in browser fallback they should appear only when the runtime supports them.

## Layout

Default app shell is a fixed-width left navigation with a flexible content area. Pages use full-width work surfaces, compact toolbars, and table-first layouts. Avoid nested cards and avoid wrapping every section in floating panels.

The desktop shell is the primary layout target. The mobile and browser fallback shells use bottom navigation or degraded controls with the same primary routes. Dense tables should degrade through wrapping, horizontal scrolling, or compact controls rather than hiding required actions.

## Language

Chinese is the primary interface language, with English available through the language switch. Every user-facing string must go through one of these so the shell, dialogs, toasts, empty states, settings, native errors and run logs all stay bilingual:

- React components: `text(zh, en)` from `useI18n()`.
- Non-React modules under `src/lib/`: `i18nText(zh, en)`, or an explicit `locale` parameter when the caller already has one.
- Module-level tables: `{ zh, en }` pairs read with `localizedText(entry, locale)` from `src/lib/format.ts`.
- Rust (`src-tauri/src/lib.rs`): `trf!("中文", "English")`, which is `format!` with a language switch. Wrap every user-facing `format!` and `to_string()` literal.

`easy-console/no-bare-cjk` enforces this in ESLint. Where a string genuinely has to match localized text produced elsewhere — status messages coming back from Rust, for example — disable the rule on that line with a comment explaining why.

### Which mechanism

`text(zh, en)` is the default and the intended one for text that lives next to the UI. Keeping both languages on the same line is what stops them drifting apart.

The `t("key")` dictionary in `src/lib/i18n.tsx` is for strings selected **by data** rather than written inline: the navigation table, the shortcut table, and route titles pick their key at runtime and need a `TranslationKey` to stay type-safe. Do not add dictionary keys for one-off component text — that is how the dictionary accumulated 31 dead entries, all of which were pruned once the rule above made them visible.

The webview pushes the active locale to the native side through the `set_locale` command. The CLI and MCP resolve their own locale from `--lang`, then `EASY_CONSOLE_LANG`, then the system locale, then English.

## Motion

Motion is limited to 150-200 ms state transitions for hover, focus, drawer open, and loading indicators. No decorative page-load animation.
