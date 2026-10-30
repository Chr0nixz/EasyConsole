/**
 * Deliberate SSH terminal color values, centralized per the P2-4 token review.
 *
 * These are not app-chrome tokens: xterm consumes them through canvas/WebGL
 * rendering, which parses concrete color strings and cannot resolve CSS custom
 * properties (`var(--...)` is ignored by canvas `fillStyle` and by the xterm
 * theme parser). Keep them as literals here, in one place, rather than
 * scattering them across components.
 */
import type { SshCustomColors } from "./types";
import type { SshTerminalTheme } from "./app-settings";

/**
 * Background/foreground of the built-in dark terminal intentionally mirror the
 * chrome tokens `--color-app-terminalBg` / `--color-app-terminalText` in
 * `styles.css` (oklch(0.18 0.028 255) / oklch(0.9 0.018 255)). Keep both sides
 * in sync when changing either.
 */
const SSH_TERMINAL_THEMES: Record<Exclude<SshTerminalTheme, "custom">, { background: string; foreground: string; cursor: string }> = {
  dark: {
    background: "oklch(0.18 0.028 255)",
    foreground: "oklch(0.9 0.018 255)",
    cursor: "oklch(0.78 0.12 235)",
  },
  light: {
    background: "oklch(0.98 0.005 255)",
    foreground: "oklch(0.2 0.02 255)",
    cursor: "oklch(0.3 0.15 235)",
  },
  /** Persisted as "hacker"; labeled 绿色终端/Green in the UI. */
  hacker: {
    background: "oklch(0.05 0.01 145)",
    foreground: "oklch(0.85 0.2 145)",
    cursor: "oklch(0.9 0.25 145)",
  },
};

export function resolveBuiltinTerminalTheme(theme: Exclude<SshTerminalTheme, "custom">) {
  return SSH_TERMINAL_THEMES[theme];
}

/**
 * Overview-ruler-only search decorations: enabling decorations is what makes
 * the search addon report match counts, and scrollbar stripes stay visually
 * restrained where in-terminal match highlighting would not. The active color
 * matches `--color-app-accent`; the idle stripe is a lighter wash of the same
 * hue.
 */
export const SSH_SEARCH_DECORATIONS = {
  decorations: {
    matchOverviewRuler: "oklch(0.62 0.1 250 / 0.7)",
    activeMatchColorOverviewRuler: "oklch(0.5 0.145 250)",
  },
} as const;

/** Default palette for the user-customizable terminal theme (Catppuccin Mocha). */
export const DEFAULT_CUSTOM_COLORS: SshCustomColors = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selection: "#585b7066",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};
