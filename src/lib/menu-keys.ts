import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Roving focus for a small `role="menu"`: ArrowUp/ArrowDown wrap, Home/End jump.
 * Returns true when the key moved focus (the caller then does nothing else).
 */
export function moveMenuFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  if (items.length === 0) return false;
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (event.key === "ArrowDown") next = (index + 1) % items.length;
  else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  if (next < 0) return false;
  event.preventDefault();
  items[next]?.focus();
  return true;
}
