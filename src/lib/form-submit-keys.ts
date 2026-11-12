import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Input types that act on Enter themselves; every other `<input>` would submit the form implicitly. */
const ACTIVATES_ON_ENTER = new Set(["button", "submit", "reset", "image", "file"]);

/**
 * For a form whose submit spends money. The browser submits a form when Enter is pressed in
 * one of its text fields, which turns a reflex (Enter after typing a name) into a billed
 * creation. Plain Enter in a field does nothing here; ⌘/Ctrl+Enter submits from anywhere
 * in the form as a deliberate two-key accelerator. IME composition is left alone, so
 * confirming a Chinese candidate with Enter never reaches this guard.
 */
export function guardImplicitSubmit(event: ReactKeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    event.currentTarget.requestSubmit();
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !ACTIVATES_ON_ENTER.has(target.type))
  ) {
    event.preventDefault();
  }
}

/** The accelerator `guardImplicitSubmit` honours, as `aria-keyshortcuts` and as a visible hint. */
export function submitShortcut(isApplePlatform: boolean) {
  return isApplePlatform
    ? { aria: "Meta+Enter", label: "⌘ Enter" }
    : { aria: "Control+Enter", label: "Ctrl Enter" };
}
