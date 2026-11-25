import { describe, expect, it } from "vitest";

import { TOKEN_STORAGE_KEY } from "./api-client";
import {
  exportLocalDataBackup,
  importLocalDataBackup,
  nonSecretBackupSections,
  presentBackupSections,
  secretBackupSections,
  type LocalDataBackup,
} from "./local-data-backup";
import { APP_SETTINGS_STORAGE_KEY, getAccountAppSettings, parseAccountSettingsStore } from "./app-settings";
import { TASK_TEMPLATES_STORAGE_KEY } from "./task-templates";
import { RESOURCE_PRESETS_STORAGE_KEY, loadResourcePresets } from "./resource-presets";
import { SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts } from "./saved-accounts";
import type { RuntimeStorage } from "./types";

function createMemoryStorage(initial: Record<string, string> = {}): RuntimeStorage {
  const data = new Map(Object.entries(initial));
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

describe("local-data-backup credentials", () => {
  it("reads and writes secrets from credentialStorage, not ordinary storage", async () => {
    const storage = createMemoryStorage();
    const credentialStorage = createMemoryStorage({
      [TOKEN_STORAGE_KEY]: "Bearer secret-token",
      [SAVED_ACCOUNTS_STORAGE_KEY]: stringifySavedAccounts([
        {
          id: "alice",
          username: "alice",
          displayName: "Alice",
          token: "Bearer secret-token",
          lastLoginAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });

    const exported = await exportLocalDataBackup({ storage, credentialStorage }, true);
    expect(exported.includeSecrets).toBe(true);
    expect(exported.items.token).toBe("Bearer secret-token");
    expect(exported.items.savedAccounts).toHaveLength(1);

    const targetStorage = createMemoryStorage();
    const targetCredentials = createMemoryStorage();
    await importLocalDataBackup({ storage: targetStorage, credentialStorage: targetCredentials }, exported, [
      ...secretBackupSections,
    ]);

    expect(await targetStorage.get(TOKEN_STORAGE_KEY)).toBeNull();
    expect(await targetCredentials.get(TOKEN_STORAGE_KEY)).toBe("Bearer secret-token");
    expect(await targetCredentials.get(SAVED_ACCOUNTS_STORAGE_KEY)).toContain("alice");
  });

  it("omits secrets when includeSecrets is false", async () => {
    const credentialStorage = createMemoryStorage({
      [TOKEN_STORAGE_KEY]: "Bearer secret-token",
    });
    const exported = await exportLocalDataBackup({ storage: createMemoryStorage(), credentialStorage }, false);
    expect(exported.items.token).toBeUndefined();
    expect(exported.items.savedAccounts).toBeUndefined();
  });
});

describe("local-data-backup resource presets", () => {
  it("exports and re-imports resource presets", async () => {
    const storage = createMemoryStorage({
      [RESOURCE_PRESETS_STORAGE_KEY]: JSON.stringify([
        {
          id: "preset-1",
          name: "开发机",
          cpu: 4,
          gpu: 1,
          memory: 16,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
      ]),
    });

    const exported = await exportLocalDataBackup(storage, false);
    expect(exported.items.resourcePresets).toHaveLength(1);

    const target = createMemoryStorage();
    await importLocalDataBackup(target, exported, ["resourcePresets"]);

    const restored = await loadResourcePresets(target);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "preset-1", name: "开发机", cpu: 4, gpu: 1, memory: 16 });
  });
});

describe("local-data-backup partial and untrusted imports", () => {
  function backupWith(items: LocalDataBackup["items"]): LocalDataBackup {
    return { app: "EasyConsole", version: 1, exportedAt: "2026-11-25T00:00:00.000Z", includeSecrets: false, items };
  }

  it("leaves sections the backup does not carry untouched", async () => {
    const templates = JSON.stringify([{ id: "tpl-1", name: "keep me", imageId: "1" }]);
    const storage = createMemoryStorage({ [TASK_TEMPLATES_STORAGE_KEY]: templates });
    const languageOnly = backupWith({ language: "en-US" });

    expect(presentBackupSections(languageOnly)).toEqual(["language"]);
    await importLocalDataBackup(storage, languageOnly, [...nonSecretBackupSections]);

    expect(await storage.get("easy-console-language")).toBe("en-US");
    expect(await storage.get(TASK_TEMPLATES_STORAGE_KEY)).toBe(templates);
  });

  it("still imports a section the backup carries as an empty list", async () => {
    const storage = createMemoryStorage({ [TASK_TEMPLATES_STORAGE_KEY]: JSON.stringify([{ id: "tpl-1", name: "old", imageId: "1" }]) });

    await importLocalDataBackup(storage, backupWith({ taskTemplates: [] }), ["taskTemplates"]);

    expect(JSON.parse((await storage.get(TASK_TEMPLATES_STORAGE_KEY)) ?? "null")).toEqual([]);
  });

  it("keeps this install's endpoints when asked, and the backup's otherwise", async () => {
    const current = JSON.stringify({
      version: 2,
      byAccount: { __global__: { apiBaseUrl: "https://console.example/api", monitorDashboardUrl: "https://grafana.example/d/x" } },
    });
    const hostile = backupWith({
      settings: {
        version: 2,
        byAccount: {
          __global__: { apiBaseUrl: "https://attacker.example/api", monitorDashboardUrl: "https://attacker.example/d", taskAutoRefresh: true },
          "alice@console": { apiBaseUrl: "https://attacker.example/api", taskAutoRefresh: true },
        },
      },
    });

    const kept = createMemoryStorage({ [APP_SETTINGS_STORAGE_KEY]: current });
    await importLocalDataBackup(kept, hostile, ["settings"], { keepEndpoints: true });
    const keptStore = parseAccountSettingsStore(await kept.get(APP_SETTINGS_STORAGE_KEY));
    for (const account of ["__global__", "alice@console"]) {
      const settings = getAccountAppSettings(keptStore, account);
      expect(settings.apiBaseUrl).toBe("https://console.example/api");
      expect(settings.monitorDashboardUrl).toBe("https://grafana.example/d/x");
      // Everything else in the settings section still comes from the backup.
      expect(settings.taskAutoRefresh).toBe(true);
    }

    const replaced = createMemoryStorage({ [APP_SETTINGS_STORAGE_KEY]: current });
    await importLocalDataBackup(replaced, hostile, ["settings"]);
    const replacedStore = parseAccountSettingsStore(await replaced.get(APP_SETTINGS_STORAGE_KEY));
    expect(getAccountAppSettings(replacedStore, "__global__").apiBaseUrl).toBe("https://attacker.example/api");
  });
});
