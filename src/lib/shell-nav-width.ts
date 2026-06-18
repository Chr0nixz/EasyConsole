export const SHELL_NAV_WIDTH_STORAGE_KEY = "easy-console.shell-nav-width";

/** Matches previous fixed `w-60` (15rem). */
export const DEFAULT_SHELL_NAV_WIDTH = 240;

export const MIN_SHELL_NAV_WIDTH = 176;

export const MAX_SHELL_NAV_WIDTH = 360;

export function clampShellNavWidth(width: number): number {
  return Math.min(MAX_SHELL_NAV_WIDTH, Math.max(MIN_SHELL_NAV_WIDTH, Math.round(width)));
}

export function parseStoredShellNavWidth(raw: string | null): number {
  if (raw == null || raw.trim() === "") return DEFAULT_SHELL_NAV_WIDTH;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SHELL_NAV_WIDTH;
  return clampShellNavWidth(value);
}

export function readStoredShellNavWidth(storage: Pick<Storage, "getItem"> = localStorage): number {
  return parseStoredShellNavWidth(storage.getItem(SHELL_NAV_WIDTH_STORAGE_KEY));
}

export function writeStoredShellNavWidth(width: number, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(SHELL_NAV_WIDTH_STORAGE_KEY, String(clampShellNavWidth(width)));
}
