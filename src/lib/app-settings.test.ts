import { describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS, normalizeAppSettings, parseAppSettings, stringifyAppSettings } from "./app-settings";
import { DEFAULT_RUN_LOG_LIMIT, DEFAULT_RUN_LOG_RETENTION_DAYS } from "./run-logs";

describe("app settings", () => {
  it("falls back to defaults when stored data is missing or invalid", () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseAppSettings("{bad json")).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("normalizes runtime urls", () => {
    expect(
      normalizeAppSettings({
        apiBaseUrl: " http://example.com/api/ ",
        monitorDashboardUrl: " http://example.com/d/test/ ",
        notificationPreferences: {
          "task.success": "app",
          "task.failure": "off",
          "task.abnormal": "system",
        },
      }),
    ).toEqual({
      apiBaseUrl: "http://example.com/api",
      monitorDashboardUrl: "http://example.com/d/test",
      notificationPreferences: {
        "task.success": "app",
        "task.failure": "off",
        "task.abnormal": "system",
      },
      autoCheckUpdates: true,
      desktopCloseToTray: false,
      desktopClosePrompt: true,
      runLogLimit: DEFAULT_RUN_LOG_LIMIT,
      runLogRetentionDays: DEFAULT_RUN_LOG_RETENTION_DAYS,
    });
  });

  it("serializes normalized settings", () => {
    expect(JSON.parse(stringifyAppSettings({ apiBaseUrl: "http://a/api/", monitorDashboardUrl: "http://b/d/" }))).toEqual({
      apiBaseUrl: "http://a/api",
      monitorDashboardUrl: "http://b/d",
      notificationPreferences: {
        "task.success": "system",
        "task.failure": "system",
        "task.abnormal": "system",
      },
      autoCheckUpdates: true,
      desktopCloseToTray: false,
      desktopClosePrompt: true,
      runLogLimit: DEFAULT_RUN_LOG_LIMIT,
      runLogRetentionDays: DEFAULT_RUN_LOG_RETENTION_DAYS,
    });
  });

  it("fills notification preference defaults for older stored settings", () => {
    expect(parseAppSettings(JSON.stringify({ apiBaseUrl: "http://a/api", monitorDashboardUrl: "http://b/d" }))).toMatchObject({
      autoCheckUpdates: true,
      desktopCloseToTray: false,
      desktopClosePrompt: true,
      runLogLimit: DEFAULT_RUN_LOG_LIMIT,
      runLogRetentionDays: DEFAULT_RUN_LOG_RETENTION_DAYS,
      notificationPreferences: {
        "task.success": "system",
        "task.failure": "system",
        "task.abnormal": "system",
      },
    });
  });

  it("normalizes run log retention fields", () => {
    expect(normalizeAppSettings({ runLogLimit: 0, runLogRetentionDays: -5 }).runLogLimit).toBe(DEFAULT_RUN_LOG_LIMIT);
    expect(normalizeAppSettings({ runLogLimit: 500, runLogRetentionDays: 60 }).runLogLimit).toBe(500);
    expect(normalizeAppSettings({ runLogLimit: 500, runLogRetentionDays: 60 }).runLogRetentionDays).toBe(60);
    expect(normalizeAppSettings({ runLogLimit: 1.5 }).runLogLimit).toBe(DEFAULT_RUN_LOG_LIMIT);
  });
});
