import { describe, expect, it } from "vitest";

import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  DISMISSED_UPDATE_INTERVAL_MS,
  hasApkZipSignature,
  parseAppUpdateState,
  selectMobileApkAsset,
  shouldAutoCheckForUpdates,
  shouldShowDismissedUpdate,
  stringifyAppUpdateState,
  type AppUpdateInfo,
} from "./app-update";

const updateInfo: AppUpdateInfo = {
  currentVersion: "0.1.0",
  version: "0.1.1",
};

describe("app update state", () => {
  it("parses invalid or partial stored state safely", () => {
    expect(parseAppUpdateState(null)).toEqual({});
    expect(parseAppUpdateState("{bad json")).toEqual({});
    expect(parseAppUpdateState(JSON.stringify({ lastAutoCheckAt: "now", dismissedVersion: 1 }))).toEqual({
      lastAutoCheckAt: "now",
      dismissedVersion: undefined,
      dismissedAt: undefined,
      dismissedUntilNextVersion: false,
    });
    expect(parseAppUpdateState(JSON.stringify({
      dismissedVersion: "0.1.1",
      dismissedUntilNextVersion: true,
    }))).toEqual({
      lastAutoCheckAt: undefined,
      dismissedVersion: "0.1.1",
      dismissedAt: undefined,
      dismissedUntilNextVersion: true,
    });
  });

  it("serializes update state", () => {
    const state = {
      lastAutoCheckAt: "2026-05-25T00:00:00.000Z",
      dismissedVersion: "0.1.1",
      dismissedUntilNextVersion: true,
    };
    expect(parseAppUpdateState(stringifyAppUpdateState(state))).toEqual({
      ...state,
      dismissedAt: undefined,
    });
  });

  it("throttles automatic checks", () => {
    const now = Date.parse("2026-05-25T12:00:00.000Z");
    expect(shouldAutoCheckForUpdates({}, now)).toBe(true);
    expect(shouldAutoCheckForUpdates({ lastAutoCheckAt: new Date(now - AUTO_UPDATE_CHECK_INTERVAL_MS + 1).toISOString() }, now)).toBe(false);
    expect(shouldAutoCheckForUpdates({ lastAutoCheckAt: new Date(now - AUTO_UPDATE_CHECK_INTERVAL_MS).toISOString() }, now)).toBe(true);
  });

  it("hides a dismissed update only for the cooldown window", () => {
    const now = Date.parse("2026-05-25T12:00:00.000Z");
    expect(shouldShowDismissedUpdate(updateInfo, { dismissedVersion: "0.1.0", dismissedAt: new Date(now).toISOString() }, now)).toBe(true);
    expect(shouldShowDismissedUpdate(updateInfo, { dismissedVersion: "0.1.1", dismissedAt: new Date(now - DISMISSED_UPDATE_INTERVAL_MS + 1).toISOString() }, now)).toBe(false);
    expect(shouldShowDismissedUpdate(updateInfo, { dismissedVersion: "0.1.1", dismissedAt: new Date(now - DISMISSED_UPDATE_INTERVAL_MS).toISOString() }, now)).toBe(true);
  });

  it("keeps skipping a version until the next release when ignored", () => {
    const now = Date.parse("2026-05-25T12:00:00.000Z");
    expect(shouldShowDismissedUpdate(updateInfo, {
      dismissedVersion: "0.1.1",
      dismissedAt: new Date(now - DISMISSED_UPDATE_INTERVAL_MS * 10).toISOString(),
      dismissedUntilNextVersion: true,
    }, now)).toBe(false);

    expect(shouldShowDismissedUpdate({
      currentVersion: "0.1.0",
      version: "0.1.2",
    }, {
      dismissedVersion: "0.1.1",
      dismissedAt: new Date(now).toISOString(),
      dismissedUntilNextVersion: true,
    }, now)).toBe(true);
  });

  it("selects only the APK matching the native Android architecture", () => {
    const release = {
      tag_name: "v0.4.22",
      assets: [
        { name: "EasyConsole-v0.4.22-android-aarch64.apk", browser_download_url: "https://example/arm.apk", size: 10 },
        { name: "EasyConsole-v0.4.22-android-x86_64.apk", browser_download_url: "https://example/x64.apk", size: 11 },
      ],
    };

    expect(selectMobileApkAsset(release, "x86_64")?.browser_download_url).toBe("https://example/x64.apk");
    expect(selectMobileApkAsset(release, "aarch64")?.browser_download_url).toBe("https://example/arm.apk");
    expect(selectMobileApkAsset({ ...release, assets: release.assets.slice(0, 1) }, "x86_64")).toBeUndefined();
  });

  it("rejects non-APK download responses before writing them to disk", () => {
    expect(hasApkZipSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe(true);
    expect(hasApkZipSignature(new TextEncoder().encode("<html>Not found</html>"))).toBe(false);
    expect(hasApkZipSignature(new Uint8Array([0x50, 0x4b, 0x03]))).toBe(false);
  });
});
