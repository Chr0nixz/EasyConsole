import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SETTINGS_STORE_VERSION,
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SSH_SETTINGS,
  GLOBAL_SETTINGS_ACCOUNT_ID,
  getAccountAppSettings,
  getRuntimeSettings,
  hydrateAccountSshPassword,
  normalizeAppSettings,
  parseAccountSettingsStore,
  parseAppSettings,
  portForwardRuleAppliesToHost,
  saveAccountSshPassword,
  setRuntimeSettings,
  sshPasswordStorageKey,
  stringifyAccountSettingsStore,
  stringifyAppSettings,
  upsertAccountAppSettings,
  writeAccountSettingsStore,
} from "./app-settings";
import type { PortForwardRule } from "./types";
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
      taskAutoRefresh: false,
      taskAutoRefreshIntervalMs: 10_000,
      autoCheckUpdates: true,
      autoNumberDuplicateTaskNames: true,
      missedSchedulePolicy: "ask",
      missedScheduleGraceMs: 10 * 60_000,
      desktopCloseToTray: false,
      desktopClosePrompt: true,
      desktopAutostart: false,
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
      taskAutoRefresh: false,
      taskAutoRefreshIntervalMs: 10_000,
      autoCheckUpdates: true,
      autoNumberDuplicateTaskNames: true,
      missedSchedulePolicy: "ask",
      missedScheduleGraceMs: 10 * 60_000,
      desktopCloseToTray: false,
      desktopClosePrompt: true,
      desktopAutostart: false,
      runLogLimit: DEFAULT_RUN_LOG_LIMIT,
      runLogRetentionDays: DEFAULT_RUN_LOG_RETENTION_DAYS,
      ssh: DEFAULT_SSH_SETTINGS,
    });
  });

  it("fills notification preference defaults for older stored settings", () => {
    expect(parseAppSettings(JSON.stringify({ apiBaseUrl: "http://a/api", monitorDashboardUrl: "http://b/d" }))).toMatchObject({
      autoCheckUpdates: true,
      taskAutoRefresh: false,
      taskAutoRefreshIntervalMs: 10_000,
      autoNumberDuplicateTaskNames: true,
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

  it("normalizes instance list auto refresh settings", () => {
    expect(normalizeAppSettings({ taskAutoRefresh: true, taskAutoRefreshIntervalMs: 30_000 })).toMatchObject({
      taskAutoRefresh: true,
      taskAutoRefreshIntervalMs: 30_000,
    });
    expect(normalizeAppSettings({ taskAutoRefresh: true, taskAutoRefreshIntervalMs: 1_000 })).toMatchObject({
      taskAutoRefresh: true,
      taskAutoRefreshIntervalMs: 10_000,
    });
  });

  it("defaults the missed schedule policy to ask with a 10-minute grace window", () => {
    expect(DEFAULT_APP_SETTINGS).toMatchObject({
      missedSchedulePolicy: "ask",
      missedScheduleGraceMs: 10 * 60_000,
    });
  });

  it("normalizes missed schedule policy and rejects unknown values", () => {
    expect(normalizeAppSettings({ missedSchedulePolicy: "run", missedScheduleGraceMs: 30 * 60_000 })).toMatchObject({
      missedSchedulePolicy: "run",
      missedScheduleGraceMs: 30 * 60_000,
    });
    // Stored payloads go through parseAppSettings, so unknown values arrive as
    // untyped JSON rather than a typed Partial<AppSettings>.
    expect(parseAppSettings(JSON.stringify({ missedSchedulePolicy: "sometimes" })).missedSchedulePolicy).toBe("ask");
    expect(normalizeAppSettings({ missedScheduleGraceMs: 7 * 60_000 }).missedScheduleGraceMs).toBe(10 * 60_000);
    expect(normalizeAppSettings({ missedScheduleGraceMs: 0 }).missedScheduleGraceMs).toBe(10 * 60_000);
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
    expect(getAccountAppSettings(roundTrip, "alice").apiBaseUrl).toBe("http://alice/api");
    expect(getAccountAppSettings(roundTrip, "bob").apiBaseUrl).toBe("http://bob/api");
    // The store JSON never persists the SSH default password; it lives in
    // secureStorage instead.
    expect(getAccountAppSettings(roundTrip, "alice").ssh.defaultPassword).toBe("");
    expect(getAccountAppSettings(roundTrip, "bob").ssh.defaultPassword).toBe("");
  });
});

describe("SSH default password storage", () => {
  function createMemoryStorage() {
    const data = new Map<string, string>();
    return {
      data,
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => {
        data.set(key, value);
      },
      remove: async (key: string) => {
        data.delete(key);
      },
    };
  }

  it("saves and clears the password under a per-account key", async () => {
    const secureStorage = createMemoryStorage();

    await saveAccountSshPassword(secureStorage, "alice", "pw-a");
    expect(secureStorage.data.get(sshPasswordStorageKey("alice"))).toBe("pw-a");

    await saveAccountSshPassword(secureStorage, "alice", "");
    expect(secureStorage.data.has(sshPasswordStorageKey("alice"))).toBe(false);
  });

  it("hydrate loads the secure value into runtime settings", async () => {
    const storage = createMemoryStorage();
    const secureStorage = createMemoryStorage();
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "" } });
    await saveAccountSshPassword(secureStorage, "alice", "pw-a");

    const password = await hydrateAccountSshPassword(storage, secureStorage, "alice");

    expect(password).toBe("pw-a");
    expect(getRuntimeSettings().ssh.defaultPassword).toBe("pw-a");
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
  });

  it("hydrate migrates a legacy plaintext copy out of the store", async () => {
    const storage = createMemoryStorage();
    const secureStorage = createMemoryStorage();
    // Simulate settings written by an older version: the password sits inside
    // the persisted store JSON.
    await writeAccountSettingsStore(storage, {
      version: ACCOUNT_SETTINGS_STORE_VERSION,
      byAccount: {
        alice: { ...DEFAULT_APP_SETTINGS, ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "legacy-pw" } },
      },
    });
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "legacy-pw" } });

    const password = await hydrateAccountSshPassword(storage, secureStorage, "alice");

    expect(password).toBe("legacy-pw");
    expect(secureStorage.data.get(sshPasswordStorageKey("alice"))).toBe("legacy-pw");
    const storeRaw = await storage.get(APP_SETTINGS_STORAGE_KEY);
    expect(storeRaw).not.toContain("legacy-pw");
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
  });

  it("hydrate with persist:false keeps the password session-only and drops stored copies", async () => {
    const storage = createMemoryStorage();
    const secureStorage = createMemoryStorage();
    // Simulate a web store written by an older version: the SSH password sits
    // inside the persisted JSON and a copy exists under the secure key.
    await writeAccountSettingsStore(storage, {
      version: ACCOUNT_SETTINGS_STORE_VERSION,
      byAccount: {
        alice: { ...DEFAULT_APP_SETTINGS, ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "web-legacy" } },
      },
    });
    setRuntimeSettings({ ...DEFAULT_APP_SETTINGS, ssh: { ...DEFAULT_SSH_SETTINGS, defaultPassword: "web-legacy" } });
    await saveAccountSshPassword(secureStorage, "alice", "web-legacy");

    const password = await hydrateAccountSshPassword(storage, secureStorage, "alice", {
      persist: false,
    });

    // The legacy value still hydrates into memory for this session...
    expect(password).toBe("web-legacy");
    expect(getRuntimeSettings().ssh.defaultPassword).toBe("web-legacy");
    // ...but nothing may outlive the session on the web runtime: the secure
    // copy is gone and the store was rewritten without the plaintext.
    expect(secureStorage.data.has(sshPasswordStorageKey("alice"))).toBe(false);
    const storeRaw = await storage.get(APP_SETTINGS_STORAGE_KEY);
    expect(storeRaw).not.toContain("web-legacy");
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
  });
});

describe("port forward rule host scoping", () => {
  const baseRule = { type: "local", localHost: "127.0.0.1", localPort: 8080, remoteHost: "10.0.0.1", remotePort: 80 } as const;

  it("preserves an optional session host when normalizing", () => {
    const scoped = normalizeAppSettings({
      ssh: { ...DEFAULT_SSH_SETTINGS, portForwards: [{ id: "pf-1", ...baseRule, enabled: true, host: " 10.0.0.8 " }] },
    }).ssh.portForwards;
    expect(scoped).toHaveLength(1);
    expect(scoped[0].host).toBe("10.0.0.8");

    const unscoped = normalizeAppSettings({
      ssh: { ...DEFAULT_SSH_SETTINGS, portForwards: [{ id: "pf-2", ...baseRule, enabled: true, host: "   " }] },
    }).ssh.portForwards;
    expect(unscoped[0].host).toBeUndefined();
  });

  it("matches unscoped rules against every host and scoped rules exactly, case-insensitively", () => {
    const unscoped = { id: "pf-1", ...baseRule, remotePort: 80, enabled: true } as PortForwardRule;
    const scoped = { id: "pf-2", ...baseRule, remotePort: 80, enabled: true, host: "10.0.0.8" } as PortForwardRule;

    expect(portForwardRuleAppliesToHost(unscoped, "anything.example")).toBe(true);
    expect(portForwardRuleAppliesToHost(scoped, "10.0.0.8")).toBe(true);
    // Surrounding whitespace and letter case are ignored.
    expect(portForwardRuleAppliesToHost(scoped, " 10.0.0.8 ")).toBe(true);
    expect(portForwardRuleAppliesToHost(scoped, "10.0.0.9")).toBe(false);
    expect(portForwardRuleAppliesToHost(scoped, "")).toBe(false);
  });
});
