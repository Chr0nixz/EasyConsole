import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

import { i18nText } from "./i18n-text";
import { browserRuntime } from "./runtime";

export const APP_UPDATE_STATE_STORAGE_KEY = "easy-console.update-state";
export const APP_UPDATE_RELEASE_URL = "https://github.com/Chr0nixz/EasyConsole/releases/latest";
export const APP_UPDATE_ENDPOINT_URL = "https://github.com/Chr0nixz/EasyConsole/releases/latest/download/latest.json";
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DISMISSED_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type AppUpdateInfo = {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
};

export type AppUpdateProgress = {
  loaded: number;
  total?: number;
  percent: number;
};

export type AppUpdateCheckResult =
  | { kind: "unsupported"; currentVersion?: string }
  | { kind: "upToDate"; currentVersion: string }
  | { kind: "available"; info: AppUpdateInfo; update: Update };

export type AppUpdateStateSnapshot = {
  lastAutoCheckAt?: string;
  dismissedVersion?: string;
  dismissedAt?: string;
};

export function parseAppUpdateState(raw: string | null): AppUpdateStateSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<AppUpdateStateSnapshot>;
    return {
      lastAutoCheckAt: typeof parsed.lastAutoCheckAt === "string" ? parsed.lastAutoCheckAt : undefined,
      dismissedVersion: typeof parsed.dismissedVersion === "string" ? parsed.dismissedVersion : undefined,
      dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : undefined,
    };
  } catch {
    return {};
  }
}

export function stringifyAppUpdateState(state: AppUpdateStateSnapshot) {
  return JSON.stringify(state);
}

function timeValue(value?: string) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function shouldAutoCheckForUpdates(state: AppUpdateStateSnapshot, now = Date.now()) {
  return now - timeValue(state.lastAutoCheckAt) >= AUTO_UPDATE_CHECK_INTERVAL_MS;
}

export function shouldShowDismissedUpdate(info: AppUpdateInfo, state: AppUpdateStateSnapshot, now = Date.now()) {
  if (state.dismissedVersion !== info.version) return true;
  return now - timeValue(state.dismissedAt) >= DISMISSED_UPDATE_INTERVAL_MS;
}

export async function loadAppUpdateState() {
  return parseAppUpdateState(await browserRuntime.storage.get(APP_UPDATE_STATE_STORAGE_KEY));
}

export async function saveAppUpdateState(state: AppUpdateStateSnapshot) {
  await browserRuntime.storage.set(APP_UPDATE_STATE_STORAGE_KEY, stringifyAppUpdateState(state));
}

export async function getCurrentAppVersion() {
  if (!browserRuntime.supportsUpdater) return undefined;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  if (!browserRuntime.supportsUpdater) {
    return { kind: "unsupported", currentVersion: await getCurrentAppVersion() };
  }

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 15_000 });
  if (!update) {
    const currentVersion = await getCurrentAppVersion();
    return {
      kind: "upToDate",
      currentVersion: currentVersion ?? i18nText("未知版本", "Unknown version"),
    };
  }

  return {
    kind: "available",
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
    },
  };
}

export async function downloadAndInstallAppUpdate(
  update: Update,
  onProgress: (progress: AppUpdateProgress) => void,
) {
  let loaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      loaded = 0;
      total = event.data.contentLength;
    } else if (event.event === "Progress") {
      loaded += event.data.chunkLength;
    } else if (event.event === "Finished") {
      if (total) loaded = total;
    }

    onProgress({
      loaded,
      total,
      percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
    });
  });
}

export async function relaunchAppAfterUpdate() {
  if (!browserRuntime.supportsUpdater) throw new Error(i18nText("当前环境不是桌面端", "The current environment is not the desktop app"));
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
