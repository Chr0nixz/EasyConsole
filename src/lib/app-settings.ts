import { API_BASE_URL } from "./api-client";
import { DEFAULT_MONITOR_DASHBOARD_URL } from "./monitor-dashboard-core";

type ImportMetaWithEnv = ImportMeta & {
  env?: {
    VITE_MONITOR_DASHBOARD_URL?: string;
  };
};

export type AppSettings = {
  apiBaseUrl: string;
  monitorDashboardUrl: string;
  notificationPreferences: NotificationPreferences;
  desktopCloseToTray: boolean;
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

export const DEFAULT_APP_SETTINGS: AppSettings = {
  apiBaseUrl: API_BASE_URL,
  monitorDashboardUrl:
    (import.meta as ImportMetaWithEnv).env?.VITE_MONITOR_DASHBOARD_URL || DEFAULT_MONITOR_DASHBOARD_URL,
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
  desktopCloseToTray: false,
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

export function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    apiBaseUrl: normalizeUrl(settings.apiBaseUrl, DEFAULT_APP_SETTINGS.apiBaseUrl),
    monitorDashboardUrl: normalizeUrl(settings.monitorDashboardUrl, DEFAULT_APP_SETTINGS.monitorDashboardUrl),
    notificationPreferences: normalizeNotificationPreferences(settings.notificationPreferences),
    desktopCloseToTray: settings.desktopCloseToTray === true,
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
