import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { motionEnabled } from "../lib/exit-motion";
import { browserRuntime } from "../lib/runtime";
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  normalizeThemePreference,
  readThemeHint,
  resolveTheme,
  subscribeSystemTheme,
  systemPrefersDark,
  writeThemeHint,
  type ThemePreference,
} from "../lib/theme";
import { ThemeContext, type ThemeContextValue } from "../lib/use-theme";

/**
 * Swaps the theme inside a brief view-transition crossfade (see styles.css), so the
 * whole window changes at once instead of repainting region by region. Instant where
 * view transitions are missing or reduced motion is requested.
 */
function crossfadeTheme(apply: () => void) {
  if (typeof document.startViewTransition !== "function" || !motionEnabled()) {
    apply();
    return;
  }
  document.startViewTransition(apply);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemeHint);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    let cancelled = false;
    void browserRuntime.storage.get(THEME_STORAGE_KEY).then((stored) => {
      const next = normalizeThemePreference(stored);
      if (!cancelled && next) setPreferenceState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => subscribeSystemTheme(setSystemDark), []);

  useEffect(() => {
    applyThemePreference(preference, systemDark);
    void browserRuntime.setNativeTheme?.(preference === "system" ? null : preference);
  }, [preference, systemDark]);

  const setPreference = useCallback((next: ThemePreference) => {
    if (resolveTheme(next, systemDark) !== resolveTheme(preference, systemDark)) {
      crossfadeTheme(() => applyThemePreference(next, systemDark));
    }
    setPreferenceState(next);
    writeThemeHint(next);
    void browserRuntime.storage.set(THEME_STORAGE_KEY, next);
  }, [preference, systemDark]);

  const value = useMemo<ThemeContextValue>(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
