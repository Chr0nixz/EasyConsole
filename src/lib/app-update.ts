import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

import { i18nText } from "./i18n-text";
import { browserRuntime } from "./runtime";

export const APP_UPDATE_STATE_STORAGE_KEY = "easy-console.update-state";
export const APP_UPDATE_RELEASE_URL = "https://github.com/Chr0nixz/EasyConsole/releases/latest";
export const APP_UPDATE_ENDPOINT_URL = "https://github.com/Chr0nixz/EasyConsole/releases/latest/download/latest.json";
export const GITHUB_API_RELEASE_URL = "https://api.github.com/repos/Chr0nixz/EasyConsole/releases/latest";
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DISMISSED_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type AppUpdateInfo = {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  apkUrl?: string;
};

export type AppUpdateProgress = {
  loaded: number;
  total?: number;
  percent: number;
};

export type AppUpdateCheckResult =
  | { kind: "unsupported"; currentVersion?: string }
  | { kind: "upToDate"; currentVersion: string }
  | { kind: "available"; info: AppUpdateInfo; update?: Update };

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

  if (browserRuntime.isMobile) {
    return checkForMobileAppUpdate();
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
  if (browserRuntime.isMobile) return; // Mobile uses APK install, no relaunch needed
  if (!browserRuntime.supportsUpdater) throw new Error(i18nText("当前环境不是桌面端", "The current environment is not the desktop app"));
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

function isNewerVersion(current: string, remote: string): boolean {
  const currentParts = current.split(".").map(Number);
  const remoteParts = remote.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const remotePart = remoteParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (remotePart > currentPart) return true;
    if (remotePart < currentPart) return false;
  }
  return false;
}

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GitHubRelease = {
  tag_name: string;
  body?: string;
  published_at?: string;
  assets: GitHubReleaseAsset[];
};

export async function checkForMobileAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = await getCurrentAppVersion();
  if (!currentVersion) {
    return { kind: "unsupported" };
  }

  const response = await fetch(GITHUB_API_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub API 请求失败：${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as GitHubRelease;
  const remoteVersion = release.tag_name.replace(/^v/, "");

  if (!isNewerVersion(currentVersion, remoteVersion)) {
    return { kind: "upToDate", currentVersion };
  }

  // Detect device architecture: default to aarch64 (most Android devices)
  const userAgent = navigator.userAgent.toLowerCase();
  const arch = userAgent.includes("x86_64") || userAgent.includes("x86-64") ? "x86_64" : "aarch64";

  const apkAsset = release.assets.find(
    (asset) => asset.name === `EasyConsole-${release.tag_name}-android-${arch}.apk`,
  );
  // Fall back to any APK asset if arch-specific one is not found
  const fallbackAsset = apkAsset ?? release.assets.find((asset) => asset.name.endsWith(".apk"));

  if (!fallbackAsset) {
    throw new Error(i18nText("未找到可用的 APK 下载资源", "No APK download asset found in release"));
  }

  return {
    kind: "available",
    info: {
      version: remoteVersion,
      currentVersion,
      date: release.published_at,
      body: release.body,
      apkUrl: fallbackAsset.browser_download_url,
    },
  };
}

export async function downloadMobileApk(
  apkUrl: string,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<string> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const { downloadDir, join } = await import("@tauri-apps/api/path");

  // Extract filename from URL
  const urlFilename = apkUrl.split("/").pop() ?? "EasyConsole-update.apk";
  const downloads = await downloadDir();
  const targetPath = await join(downloads, urlFilename);

  const response = await tauriFetch(apkUrl, { connectTimeout: 15_000 });
  if (!response.ok) {
    throw new Error(`APK 下载失败：${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length")) || undefined;

  // Stream the response body to track download progress
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback: no stream support, download as blob
    const buffer = await response.arrayBuffer();
    await writeFile(targetPath, new Uint8Array(buffer));
    onProgress({ loaded: buffer.byteLength, total: buffer.byteLength, percent: 100 });
    return targetPath;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({
      loaded,
      total: contentLength,
      percent: contentLength ? Math.min(100, Math.round((loaded / contentLength) * 100)) : 0,
    });
  }

  // Concatenate chunks and write file
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await writeFile(targetPath, result);
  onProgress({ loaded, total: loaded, percent: 100 });
  return targetPath;
}

export async function installMobileApk(apkPath: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_apk", { path: apkPath });
}
