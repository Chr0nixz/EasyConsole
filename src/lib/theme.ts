export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "easy-console-theme";
export const themePreferences: ThemePreference[] = ["light", "dark", "system"];

/** Header surface colors, mirrored for `<meta name="theme-color">` (browser chrome, Android). */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#fefdfa",
  dark: "#161a1f",
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function normalizeThemePreference(value: unknown): ThemePreference | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function subscribeSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/**
 * Synchronous first-paint hint. The authoritative value lives in runtime storage,
 * which is async on desktop; this copy only avoids a light flash for users who
 * picked dark explicitly while their OS is light (or the reverse).
 */
export function readThemeHint(): ThemePreference {
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    return "system";
  }
}

export function writeThemeHint(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (private mode, quota); the CSS media query still applies.
  }
}

/** Applies a preference to `<html>`. "system" leaves the choice to the CSS media query. */
export function applyThemePreference(preference: ThemePreference, systemDark = systemPrefersDark()): ResolvedTheme {
  const resolved = resolveTheme(preference, systemDark);
  if (typeof document === "undefined") return resolved;
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[resolved]);
  return resolved;
}

/** Called once before the first render so the shell never paints in the wrong theme. */
export function applyInitialTheme() {
  applyThemePreference(readThemeHint());
}
