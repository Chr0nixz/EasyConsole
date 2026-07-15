import { API_BASE_URL } from "./api-client";
import { DEFAULT_MONITOR_DASHBOARD_URL } from "./monitor-dashboard-core";
import { DEFAULT_RUN_LOG_LIMIT, DEFAULT_RUN_LOG_RETENTION_DAYS } from "./run-logs";
import type { PortForwardRule, PortForwardType, SshAuthMode, SshCustomColors } from "./types";

type ImportMetaWithEnv = ImportMeta & {
  env?: {
    VITE_MONITOR_DASHBOARD_URL?: string;
  };
};

export type SshTerminalTheme = "dark" | "light" | "hacker" | "custom";

export type { SshAuthMode } from "./types";
export type { PortForwardRule, PortForwardType, SshCustomColors } from "./types";

export type SshSettings = {
  defaultUsername: string;
  defaultPort: number;
  defaultCols: number;
  defaultRows: number;
  connectTimeoutSec: number;
  keepaliveIntervalSec: number;
  termType: string;
  sshKeyPath: string;
  authMode: SshAuthMode;
  portForwards: PortForwardRule[];
  maxHistoryEntries: number;
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    cursorBlink: boolean;
    theme: SshTerminalTheme;
    webglRenderer: boolean;
    webLinks: boolean;
    customColors: SshCustomColors;
    fontPreset: string;
    logAutoName: boolean;
  };
};

export type AppSettings = {
  apiBaseUrl: string;
  monitorDashboardUrl: string;
  notificationPreferences: NotificationPreferences;
  autoCheckUpdates: boolean;
  desktopCloseToTray: boolean;
  desktopClosePrompt: boolean;
  runLogLimit: number;
  runLogRetentionDays: number;
  ssh: SshSettings;
};

export type ImportantNotificationEvent = "task.success" | "task.failure" | "task.abnormal";

export type NotificationMode = "off" | "app" | "system";

export type NotificationPreferences = Record<ImportantNotificationEvent, NotificationMode>;

export const APP_SETTINGS_STORAGE_KEY = "easy-console.settings";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  "task.success": "system",
  "task.failure": "system",
  "task.abnormal": "system",
};

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

export const SSH_FONT_PRESETS: Array<{ id: string; label: string; value: string }> = [
  { id: "consolas", label: "Consolas", value: 'Consolas, "SFMono-Regular", "Cascadia Mono", monospace' },
  { id: "cascadia", label: "Cascadia Mono", value: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", value: '"JetBrains Mono", "Fira Code", Consolas, monospace' },
  { id: "fira", label: "Fira Code", value: '"Fira Code", "JetBrains Mono", Consolas, monospace' },
  { id: "meslo", label: "Meslo", value: '"Meslo LG S", "Meslo LGS NF", monospace' },
  { id: "source", label: "Source Code Pro", value: '"Source Code Pro", "SFMono-Regular", monospace' },
  { id: "monospace", label: "系统默认", value: "monospace" },
  { id: "custom", label: "自定义", value: "" },
];

export const DEFAULT_SSH_SETTINGS: SshSettings = {
  defaultUsername: "ubuntu",
  defaultPort: 22,
  defaultCols: 120,
  defaultRows: 32,
  connectTimeoutSec: 15,
  keepaliveIntervalSec: 20,
  termType: "xterm-256color",
  sshKeyPath: "",
  authMode: "password",
  portForwards: [],
  maxHistoryEntries: 20,
  terminal: {
    fontFamily: 'Consolas, "SFMono-Regular", "Cascadia Mono", monospace',
    fontSize: 13,
    scrollback: 10_000,
    cursorBlink: true,
    theme: "dark",
    webglRenderer: true,
    webLinks: true,
    customColors: DEFAULT_CUSTOM_COLORS,
    fontPreset: "consolas",
    logAutoName: true,
  },
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  apiBaseUrl: API_BASE_URL,
  monitorDashboardUrl:
    (import.meta as ImportMetaWithEnv).env?.VITE_MONITOR_DASHBOARD_URL || DEFAULT_MONITOR_DASHBOARD_URL,
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
  autoCheckUpdates: true,
  desktopCloseToTray: false,
  desktopClosePrompt: true,
  runLogLimit: DEFAULT_RUN_LOG_LIMIT,
  runLogRetentionDays: DEFAULT_RUN_LOG_RETENTION_DAYS,
  ssh: DEFAULT_SSH_SETTINGS,
};

let runtimeSettings: AppSettings = DEFAULT_APP_SETTINGS;

function trimSlash(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeUrl(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimSlash(trimmed);
}

function normalizeNotificationMode(value: unknown, fallback: NotificationMode): NotificationMode {
  return value === "off" || value === "app" || value === "system" ? value : fallback;
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const raw = value && typeof value === "object" ? value as Partial<Record<ImportantNotificationEvent, unknown>> : {};
  return {
    "task.success": normalizeNotificationMode(raw["task.success"], DEFAULT_NOTIFICATION_PREFERENCES["task.success"]),
    "task.failure": normalizeNotificationMode(raw["task.failure"], DEFAULT_NOTIFICATION_PREFERENCES["task.failure"]),
    "task.abnormal": normalizeNotificationMode(raw["task.abnormal"], DEFAULT_NOTIFICATION_PREFERENCES["task.abnormal"]),
  };
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function normalizeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeSshTerminalTheme(value: unknown): SshTerminalTheme {
  return value === "dark" || value === "light" || value === "hacker" || value === "custom" ? value : "dark";
}

function normalizeSshAuthMode(value: unknown): SshAuthMode {
  return value === "password" || value === "key" ? value : "password";
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_COLOR_ALPHA_RE = /^#[0-9a-fA-F]{8}$/;

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (HEX_COLOR_RE.test(trimmed) || HEX_COLOR_ALPHA_RE.test(trimmed)) return trimmed;
  return fallback;
}

function normalizeSshCustomColors(value: unknown): SshCustomColors {
  const raw = value && typeof value === "object" ? (value as Partial<Record<keyof SshCustomColors, unknown>>) : {};
  const defaults = DEFAULT_CUSTOM_COLORS;
  const keys: Array<keyof SshCustomColors> = [
    "background", "foreground", "cursor", "selection",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];
  const result = {} as SshCustomColors;
  for (const key of keys) {
    result[key] = normalizeHexColor(raw[key], defaults[key]);
  }
  return result;
}

function normalizePortForwardType(value: unknown): PortForwardType {
  return value === "local" || value === "remote" || value === "dynamic" ? value : "local";
}

function normalizePortForwardRule(value: unknown, index: number): PortForwardRule | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PortForwardRule>;
  const id = typeof raw.id === "string" && raw.id ? raw.id : `pf-${index}`;
  const type = normalizePortForwardType(raw.type);
  const localHost = normalizeString(raw.localHost, "127.0.0.1");
  const localPort = normalizePositiveInteger(raw.localPort, 0);
  const remoteHost = normalizeString(raw.remoteHost, "");
  const remotePort = normalizePositiveInteger(raw.remotePort, 0);
  if (localPort === 0) return null;
  if (type !== "dynamic" && (remoteHost === "" || remotePort === 0)) return null;
  return { id, type, localHost, localPort, remoteHost, remotePort, enabled: raw.enabled === true };
}

function normalizePortForwards(value: unknown): PortForwardRule[] {
  if (!Array.isArray(value)) return [];
  const rules: PortForwardRule[] = [];
  value.forEach((item, index) => {
    const rule = normalizePortForwardRule(item, index);
    if (rule) rules.push(rule);
  });
  return rules;
}

function normalizeFontPreset(value: unknown): string {
  if (typeof value !== "string") return "consolas";
  const preset = SSH_FONT_PRESETS.find((p) => p.id === value);
  return preset ? value : "custom";
}

function normalizeSshSettings(value: unknown): SshSettings {
  const raw = value && typeof value === "object" ? (value as Partial<SshSettings>) : {};
  const rawTerminal = raw.terminal && typeof raw.terminal === "object" ? (raw.terminal as Partial<SshSettings["terminal"]>) : {};
  const defaults = DEFAULT_SSH_SETTINGS;
  return {
    defaultUsername: normalizeString(raw.defaultUsername, defaults.defaultUsername),
    defaultPort: normalizePositiveInteger(raw.defaultPort, defaults.defaultPort),
    defaultCols: normalizePositiveInteger(raw.defaultCols, defaults.defaultCols),
    defaultRows: normalizePositiveInteger(raw.defaultRows, defaults.defaultRows),
    connectTimeoutSec: normalizePositiveInteger(raw.connectTimeoutSec, defaults.connectTimeoutSec),
    keepaliveIntervalSec: normalizeNonNegativeInteger(raw.keepaliveIntervalSec, defaults.keepaliveIntervalSec),
    termType: normalizeString(raw.termType, defaults.termType),
    sshKeyPath: typeof raw.sshKeyPath === "string" ? raw.sshKeyPath : defaults.sshKeyPath,
    authMode: normalizeSshAuthMode(raw.authMode),
    portForwards: normalizePortForwards(raw.portForwards),
    maxHistoryEntries: normalizePositiveInteger(raw.maxHistoryEntries, defaults.maxHistoryEntries),
    terminal: {
      fontFamily: normalizeString(rawTerminal.fontFamily, defaults.terminal.fontFamily),
      fontSize: normalizePositiveInteger(rawTerminal.fontSize, defaults.terminal.fontSize),
      scrollback: normalizeNonNegativeInteger(rawTerminal.scrollback, defaults.terminal.scrollback),
      cursorBlink: rawTerminal.cursorBlink !== false,
      theme: normalizeSshTerminalTheme(rawTerminal.theme),
      webglRenderer: rawTerminal.webglRenderer !== false,
      webLinks: rawTerminal.webLinks !== false,
      customColors: normalizeSshCustomColors(rawTerminal.customColors),
      fontPreset: normalizeFontPreset(rawTerminal.fontPreset),
      logAutoName: rawTerminal.logAutoName !== false,
    },
  };
}

export function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    apiBaseUrl: normalizeUrl(settings.apiBaseUrl, DEFAULT_APP_SETTINGS.apiBaseUrl),
    monitorDashboardUrl: normalizeUrl(settings.monitorDashboardUrl, DEFAULT_APP_SETTINGS.monitorDashboardUrl),
    notificationPreferences: normalizeNotificationPreferences(settings.notificationPreferences),
    autoCheckUpdates: settings.autoCheckUpdates !== false,
    desktopCloseToTray: settings.desktopCloseToTray === true,
    desktopClosePrompt: settings.desktopClosePrompt !== false,
    runLogLimit: normalizePositiveInteger(settings.runLogLimit, DEFAULT_APP_SETTINGS.runLogLimit),
    runLogRetentionDays: normalizePositiveInteger(settings.runLogRetentionDays, DEFAULT_APP_SETTINGS.runLogRetentionDays),
    ssh: normalizeSshSettings(settings.ssh),
  };
}

export function parseAppSettings(raw: string | null): AppSettings {
  if (!raw) return DEFAULT_APP_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeAppSettings(parsed);
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function stringifyAppSettings(settings: Partial<AppSettings>) {
  return JSON.stringify(normalizeAppSettings(settings));
}

export function setRuntimeSettings(settings: Partial<AppSettings>) {
  runtimeSettings = normalizeAppSettings(settings);
}

export function getRuntimeSettings() {
  return runtimeSettings;
}
