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
};

export const APP_SETTINGS_STORAGE_KEY = "easy-console.settings";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  apiBaseUrl: API_BASE_URL,
  monitorDashboardUrl:
    (import.meta as ImportMetaWithEnv).env?.VITE_MONITOR_DASHBOARD_URL || DEFAULT_MONITOR_DASHBOARD_URL,
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

export function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    apiBaseUrl: normalizeUrl(settings.apiBaseUrl, DEFAULT_APP_SETTINGS.apiBaseUrl),
    monitorDashboardUrl: normalizeUrl(settings.monitorDashboardUrl, DEFAULT_APP_SETTINGS.monitorDashboardUrl),
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

export function stringifyAppSettings(settings: AppSettings) {
  return JSON.stringify(normalizeAppSettings(settings));
}

export function setRuntimeSettings(settings: Partial<AppSettings>) {
  runtimeSettings = normalizeAppSettings(settings);
}

export function getRuntimeSettings() {
  return runtimeSettings;
}
