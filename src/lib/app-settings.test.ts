import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SSH_SETTINGS,
  GLOBAL_SETTINGS_ACCOUNT_ID,
  getAccountAppSettings,
  normalizeAppSettings,
  parseAccountSettingsStore,
  parseAppSettings,
  stringifyAccountSettingsStore,
  stringifyAppSettings,
  upsertAccountAppSettings,
} from "./app-settings";
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
      ssh: DEFAULT_SSH_SETTINGS,
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
      ssh: DEFAULT_SSH_SETTINGS,
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

  it("preserves empty default SSH password", () => {
    expect(normalizeAppSettings({ ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "" } }).ssh.defaultPassword).toBe("");
    expect(normalizeAppSettings({ ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: " secret " } }).ssh.defaultPassword).toBe(" secret ");
  });

  it("migrates legacy flat settings into the global account slot", () => {
    const store = parseAccountSettingsStore(
      JSON.stringify({
        apiBaseUrl: "http://legacy/api",
        monitorDashboardUrl: "http://legacy/d",
      }),
    );
    expect(store.version).toBe(2);
    expect(getAccountAppSettings(store, GLOBAL_SETTINGS_ACCOUNT_ID).apiBaseUrl).toBe("http://legacy/api");
    expect(getAccountAppSettings(store, "alice").apiBaseUrl).toBe("http://legacy/api");
  });

  it("keeps settings independent per account", () => {
    let store = parseAccountSettingsStore(null);
    store = upsertAccountAppSettings(store, "alice", {
      ...DEFAULT_APP_SETTINGS,
      apiBaseUrl: "http://alice/api",
      ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "alice" },
    });
    store = upsertAccountAppSettings(store, "bob", {
      ...DEFAULT_APP_SETTINGS,
      apiBaseUrl: "http://bob/api",
      ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "bob" },
    });

    expect(getAccountAppSettings(store, "alice").apiBaseUrl).toBe("http://alice/api");
    expect(getAccountAppSettings(store, "alice").ssh.defaultPassword).toBe("alice");
    expect(getAccountAppSettings(store, "bob").apiBaseUrl).toBe("http://bob/api");
    expect(getAccountAppSettings(store, "bob").ssh.defaultPassword).toBe("bob");

    const roundTrip = parseAccountSettingsStore(stringifyAccountSettingsStore(store));
    expect(getAccountAppSettings(roundTrip, "alice").ssh.defaultPassword).toBe("alice");
    expect(getAccountAppSettings(roundTrip, "bob").ssh.defaultPassword).toBe("bob");
  });
});
