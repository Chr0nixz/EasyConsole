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
  /** When true, suppress auto toast/dialog for dismissedVersion until a newer version appears. */
  dismissedUntilNextVersion?: boolean;
};

export function parseAppUpdateState(raw: string | null): AppUpdateStateSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<AppUpdateStateSnapshot>;
    return {
      lastAutoCheckAt: typeof parsed.lastAutoCheckAt === "string" ? parsed.lastAutoCheckAt : undefined,
      dismissedVersion: typeof parsed.dismissedVersion === "string" ? parsed.dismissedVersion : undefined,
      dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : undefined,
      dismissedUntilNextVersion: parsed.dismissedUntilNextVersion === true,
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

/**
 * Whether auto-check may surface a toast (and historically a dialog) for this update.
 * Shell badge remains available regardless; only soft notifications are gated.
 */
export function shouldShowDismissedUpdate(info: AppUpdateInfo, state: AppUpdateStateSnapshot, now = Date.now()) {
  if (state.dismissedVersion !== info.version) return true;
  if (state.dismissedUntilNextVersion) return false;
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

export type MobileAppArchitecture = "aarch64" | "x86_64";
export type MobileApkInstallResult = "launched" | "permission-required";

export function selectMobileApkAsset(release: GitHubRelease, architecture: MobileAppArchitecture) {
  const expectedName = `EasyConsole-${release.tag_name}-android-${architecture}.apk`;
  return release.assets.find((asset) => asset.name === expectedName);
}

export function hasApkZipSignature(bytes: Uint8Array) {
  return bytes.byteLength >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04;
}

async function getMobileAppArchitecture(): Promise<MobileAppArchitecture> {
  const { invoke } = await import("@tauri-apps/api/core");
  const architecture = await invoke<string>("mobile_app_arch");
  if (architecture === "aarch64" || architecture === "x86_64") return architecture;
  throw new Error(i18nText(`当前 Android 架构不受支持：${architecture}`, `Unsupported Android architecture: ${architecture}`));
}

export async function checkForMobileAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = await getCurrentAppVersion();
  if (!currentVersion) {
    return { kind: "unsupported" };
  }

  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const response = await tauriFetch(GITHUB_API_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    connectTimeout: 15_000,
  });
  if (!response.ok) {
    throw new Error(`GitHub API 请求失败：${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as GitHubRelease;
  const remoteVersion = release.tag_name.replace(/^v/, "");

  if (!isNewerVersion(currentVersion, remoteVersion)) {
    return { kind: "upToDate", currentVersion };
  }

  const architecture = await getMobileAppArchitecture();
  const apkAsset = selectMobileApkAsset(release, architecture);
  if (!apkAsset) {
    throw new Error(i18nText(
      `未找到适用于 ${architecture} 的 APK 下载资源`,
      `No APK download asset is available for ${architecture}`,
    ));
  }

  return {
    kind: "available",
    info: {
      version: remoteVersion,
      currentVersion,
      date: release.published_at,
      body: release.body,
      apkUrl: apkAsset.browser_download_url,
    },
  };
}

export async function downloadMobileApk(
  apkUrl: string,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<string> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
  const { appCacheDir, join } = await import("@tauri-apps/api/path");

  const rawFilename = decodeURIComponent(new URL(apkUrl).pathname.split("/").pop() ?? "");
  const filename = /^[A-Za-z0-9._-]+\.apk$/i.test(rawFilename) ? rawFilename : "EasyConsole-update.apk";
  const updatesDir = await join(await appCacheDir(), "updates");
  await mkdir(updatesDir, { recursive: true });
  const targetPath = await join(updatesDir, filename);

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
    const bytes = new Uint8Array(buffer);
    assertApkBytes(bytes);
    await writeFile(targetPath, bytes);
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
  assertApkBytes(result);
  await writeFile(targetPath, result);
  onProgress({ loaded, total: loaded, percent: 100 });
  return targetPath;
}

function assertApkBytes(bytes: Uint8Array) {
  if (!hasApkZipSignature(bytes)) {
    throw new Error(i18nText("下载内容不是有效的 APK 文件", "The downloaded content is not a valid APK file"));
  }
}

export async function installMobileApk(apkPath: string): Promise<MobileApkInstallResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MobileApkInstallResult>("install_apk", { path: apkPath });
}
