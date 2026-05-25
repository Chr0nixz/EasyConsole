import { describe, expect, it } from "vitest";

import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  DISMISSED_UPDATE_INTERVAL_MS,
  parseAppUpdateState,
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
    });
  });

  it("serializes update state", () => {
    const state = { lastAutoCheckAt: "2026-05-25T00:00:00.000Z", dismissedVersion: "0.1.1" };
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
});
