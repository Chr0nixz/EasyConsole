---
target: App shell + login
total_score: 37
p0_count: 0
p1_count: 0
timestamp: 2026-06-28T14-47-28Z
slug: rc-components-appshell-tsx-src-pages-loginpage-tsx
---
# EasyConsole App Shell + Login Critique (re-run after fixes)

**Target:** `src/components/AppShell.tsx` + `src/pages/LoginPage.tsx` (chrome + entry experience)
**Register:** product (desktop-first control panel)
**Date:** 2026-06-28 (re-run)
**Prior score:** 29/40 (Good, lower-mid)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Status popover now groups downloads/commit/update with a summed badge + per-item progress detail. Online/offline banner, auto-refresh pause, page-enter all retained. Excellent. |
| 2 | Match System / Real World | 3 | "设置" → "API 设置" fixed. Commit button has tooltip "提交任务环境为镜像". But the status popover label still reads "Commit 队列" / "Commit queue" — English jargon in a Chinese-first UI. Tooltip softens it; the label itself still makes Jordan pause. |
| 3 | User Control and Freedom | 4 | Logout and forget-saved-account both wrapped in ConfirmDialog with destructive tone + cancel. Esc/cancel/overlay everywhere. Close prompt offers tray vs exit with "remember choice". Full control restored. |
| 4 | Consistency and Standards | 4 | More sheet and status popover both `role="dialog" aria-modal="true"` with real focus traps. LanguageSwitch wrapped in `role="group"`. Mobile and desktop "more" surfaces now share semantics. |
| 5 | Error Prevention | 4 | Confirm dialogs on both destructive actions. HTML5 `required` on login, "remember choice" on close prompt, saved-account one-tap. Guardrails now cover the previously unguarded paths. |
| 6 | Recognition Rather Than Recall | 4 | `?` cheat-sheet lists all shortcuts. CommandPalette shows inline `kbd` hints. Nav items have `title` with shortcut. Mobile search button has `aria-label` + `title`. Shortcuts are now discoverable, not hidden. |
| 7 | Flexibility and Efficiency | 3 | Shortcuts are discoverable and two new ones (g c, g m) fill the nav grid. But the command palette still navigates only — no actions (create task, retry download, toggle language). The palette promises more than it delivers; this is the remaining flexibility cap. |
| 8 | Aesthetic and Minimalist Design | 4 | Header collapsed from 7→4 actions on desktop and 5→3 on mobile via the status popover. Background work is grouped under one badge instead of three buttons. Calm, dense, operational — matches PRODUCT.md intent. |
| 9 | Error Recovery | 4 | `friendlyLoginError` maps network/401/timeout/500 to plain-language messages with retry guidance. Saved-login failure falls through to password form with username pre-filled. Domain-specific messages preserved. |
| 10 | Help and Documentation | 3 | `?` cheat-sheet, tooltips on nav/status/commit, "API 设置" label. Contextual help is solid. Still no full help system or first-run guidance, but the bar for a product-register operator tool is met. |
| **Total** | | **37/40** | **Excellent — minor polish only** |

**Delta: +8 from 29 → 37.** Band moved from "Good (lower-mid)" to "Excellent".

## Anti-Patterns Verdict

**LLM assessment:** Still does not look AI-generated. The fixes removed the one codex tell that was present (the ghost-card modal: 1px border + wide drop shadow paired on the same element). `.app-modal-panel` and `.app-terminal-modal-panel` now ship a single shadow at `0 16px 40px` with no competing border — clean product register.

No side-stripe borders, no gradient text, no glassmorphism, no hand-drawn SVG, no repeating-linear-gradient, no hero-metric template, no numbered section markers, no uppercase tracked eyebrows. The status popover is a standard dropdown pattern, not a card grid. The login left brand panel remains restrained.

**Deterministic scan:** `detect.mjs` on the seven target files returned 1 finding (exit code 2):
- `overused-font` × 1 — `src/styles.css:28`, `font-family: Inter`.

Same finding as the prior run. **False positive for this register.** The product register explicitly permits "System fonts and familiar sans defaults (Inter, SF Pro, system-ui stacks)" and DESIGN.md commits to Inter. For a desktop operator tool, Inter is earned familiarity, not a tell. Keep Inter.

**LLM/detector divergence:** None new. The detector did not flag the ghost-card fix (it never did — that was an LLM-only catch in the prior run, now resolved).

**Visual overlays:** No browser automation available in this session. No dev server started, no script injection attempted. Fallback signal: CLI detector only. No user-visible overlay.

## Overall Impression

The shell and login now feel like a finished operator tool. The previous run's two biggest risks — destructive-without-confirm and header overcrowding — are both resolved. The status popover is the right move: it groups three background-work indicators under one badge instead of competing for header real estate, and it gives each item a real description line so the user knows what "Commit" means before clicking.

The remaining gaps are polish-tier. The command palette being nav-only is the most felt limitation for a power user, but it's a feature gap, not a defect. "Commit" as an English label in a Chinese interface is a minor tonal slip that the tooltip covers. No P0 or P1 issues remain.

## What's Working

1. **The status popover is a genuine improvement, not just a refactor.** It sums active+failed+update into one badge so the user can see "something needs attention" at a glance, then opens to per-item detail with completion counts and empty-state copy ("暂无下载任务"/"No downloads"). It's a model for how to declutter a header without hiding state. The focus trap and `aria-modal="true"` make it a proper dialog, not a styled div.

2. **Destructive action confirms are correctly sized.** Logout confirm uses the danger tone with a clear "继续使用/Keep open" cancel — the wording respects that the user's intent might have been to stay. Forget-saved-account confirm is a separate dialog (not a toast/undo), which is right for an irreversible deletion. Neither is naggy for non-destructive paths.

3. **Shortcut discoverability is now best-in-class for the category.** `?` opens a cheat-sheet, the command palette shows inline `kbd` hints next to each nav command, and nav items surface their `g`-prefix shortcut in the `title`. A keyboard-first operator can now learn the accelerators without leaving the app. Adding `g c` and `g m` filled the grid so every nav destination has a shortcut.

## Priority Issues

### [P3] Command palette is navigation-only
- **What:** [CommandPalette.tsx:35-44](file:///d:/Projects/EasyConsole/src/components/CommandPalette.tsx#L35-L44) — the palette lists 8 nav destinations plus task search results. It does not run actions (create task, retry failed download, toggle language, open shortcuts). Alex expects `Cmd+K` to do things, not just go places.
- **Why it matters:** Heuristic 7 (Flexibility) is capped at 3 because of this. The palette's placeholder says "搜索页面、任务或操作" / "Search pages, tasks, or actions" but the "actions" half is unfulfilled. This is the single biggest remaining flexibility gap.
- **Fix:** Add action commands to `staticCommands`: "Create task" (opens CreateTaskDialog), "Toggle language" (calls `setLocale`), "Show shortcuts" (opens ShortcutsDialog), "Retry failed downloads" (calls `retry` on failed items). Keep nav + actions in one flat list.
- **Suggested command:** `$impeccable delight`

### [P3] "Commit" label is English jargon in a Chinese-first UI
- **What:** [AppShell.tsx:699](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L699) — the status popover labels the second item "Commit 队列" / "Commit queue". The tooltip says "提交任务环境为镜像" / "Commit task state as image", but the visible label still leads with the English word.
- **Why it matters:** Heuristic 2 (Match Real World) is capped at 3 because of this. Jordan (first-timer) reading "Commit 队列" doesn't know what "Commit" means here — git? database? The tooltip helps on hover, but the label is the first thing read.
- **Fix:** Change the label to `text("镜像提交", "Image commit")` or `text("环境存档", "State archive")`. Keep "Commit" only as the English fallback if the chosen Chinese term doesn't translate cleanly.
- **Suggested command:** `$impeccable clarify`

### [P3] No first-run guidance for the shortcuts and status popover
- **What:** The `?` cheat-sheet and status popover are discoverable on hover/title but not announced on first login. A new user lands on the dashboard with no indication that `?` exists or that the status button groups background work.
- **Why it matters:** Heuristic 10 (Help) is capped at 3. The contextual help is solid once found, but the "once found" step is still on the user. For a power-user tool this is acceptable, but a one-time tooltip on first session would close the gap.
- **Fix:** Add a one-time coach mark on first login: anchor to the status button with copy "后台下载、提交和更新都集中在这里" / "Background downloads, commits, and updates live here", and a second anchor to the command palette button with "按 ? 查看所有快捷键" / "Press ? for all shortcuts". Dismiss on click or after 10s; persist dismissal in storage.
- **Suggested command:** `$impeccable onboard`

## Persona Red Flags

### Alex (Power User) — primary persona for admin shell
- **Shortcuts now teachable:** Alex presses `?`, sees the cheat-sheet, and within a session has `g d` / `g t` / `/` in muscle memory. The hidden-shortcut red flag from the prior run is cleared.
- **One-click logout risk gone:** The confirm dialog means Alex can't misfire logout mid-task. Trust restored.
- **Status popover reads as power-user friendly:** Badge count + detail view is the Linear/Raycast pattern Alex expects.
- **Remaining red flag:** Alex opens `Cmd+K` expecting to run "Create task" or "Retry download" and gets only navigation. The palette still under-delivers for a keyboard-first operator. (P3 above.)

### Jordan (First-Timer) — primary persona for login
- **"API 设置" no longer betrays expectation:** The login link now accurately labels its destination. Trust no longer dips on first interaction.
- **Login errors are now plain language:** "网络连接异常，请检查网络后重试" instead of "NetworkError". Jordan knows what to do.
- **Forget-saved-account confirm protects against misfire:** The trash icon on a small touch target no longer deletes instantly.
- **Remaining red flag:** "Commit 队列" in the status popover is still an English word Jordan doesn't have a referent for. The tooltip explains it, but Jordan may not hover before clicking. (P3 above.)

### Sam (Accessibility-Dependent) — primary persona for admin shell
- **Nav resize is now keyboard-operable:** ArrowLeft/ArrowRight adjust width, Enter resets. `aria-keyshortcuts` announces the keys. The "focusable but not operable" red flag from the prior run is cleared.
- **More sheet focus is now trapped:** `aria-modal="true"` + the `isInside` check in the Tab handler means Tab can't escape into the page behind. The hybrid-ARIA red flag is cleared.
- **Status popover is a proper dialog:** `role="dialog" aria-modal="true"` with focus trap and Esc close. Sam can navigate it linearly.
- **Remaining red flag:** None blocking. The mobile search button now has `aria-label`. The only soft gap: the status popover's per-item buttons don't have explicit `aria-label` describing the item (they rely on visible text), which is fine for screen readers since the text is readable.

## Minor Observations

- [AppShell.tsx:699](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L699) — the empty-state copy for the commit queue says "暂无 Commit 任务" / "No commits". Once the label jargon is fixed, this string should follow the same term.
- [AppShell.tsx:629-639](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L629-L639) — the badge count IIFE inside the Button JSX is correct but slightly hard to read. Extracting to a `statusBadgeTotal` variable would clean it up.
- [LoginPage.tsx:94-97](file:///d:/Projects/EasyConsole/src/pages/LoginPage.tsx#L94-L97) — `void label;` in the confirm `run` callback is a no-op to satisfy the unused parameter. Could drop the `label` parameter entirely since the confirm dialog uses generic copy, not the account label.
- [ShortcutsDialog.tsx:6](file:///d:/Projects/EasyConsole/src/components/ShortcutsDialog.tsx#L6) — the inline `import("../lib/i18n").TranslationKey` type is correct but unusual; importing `TranslationKey` at the top would read cleaner.
- [AppShell.tsx:155-159](file:///d:/Projects/EasyConsole/src/components/AppShell.tsx#L155-L159) — the `?` shortcut handler checks both `event.key === "?"` and `event.shiftKey && event.key === "/"`. On most keyboard layouts `?` is `Shift+/`, so the second condition is the one that fires; the first is a safe fallback for layouts where `?` is unshifted. Correct, just noting the redundancy is intentional.

## Questions to Consider

- Should the command palette grow to run actions, or stay focused on navigation + task search? Growing it risks scope creep; keeping it narrow risks under-delivering on the `Cmd+K` affordance.
- Is "镜像提交" / "Image commit" the right Chinese term for operators, or does the field already use "Commit" as borrowed jargon that operators recognize? If operators say "commit 一下", the English label is correct and the tooltip is sufficient.
- Would a one-time coach mark on first login feel helpful or patronizing for this audience? The product is for operators who use similar tools daily; they may prefer to discover via `?`.
- The status popover currently shows three items (downloads, commit, update). If a fourth background-work type appears later (e.g., scheduled task execution), does the popover scale, or does it need grouping?
