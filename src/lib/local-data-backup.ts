import { TOKEN_STORAGE_KEY } from "./api-client";
import { i18nText } from "./i18n-text";
import {
  APP_SETTINGS_STORAGE_KEY,
  getAccountAppSettings,
  GLOBAL_SETTINGS_ACCOUNT_ID,
  parseAccountSettingsStore,
  stringifyAccountSettingsStore,
} from "./app-settings";
import { RUN_LOGS_STORAGE_KEY, parseRunLogs } from "./run-logs";
import { loadResourcePresets, saveResourcePresets } from "./resource-presets";
import { SAVED_ACCOUNTS_STORAGE_KEY, parseSavedAccounts, stringifySavedAccounts } from "./saved-accounts";
import { loadScheduledTasks, saveScheduledTasks } from "./scheduled-tasks";
import { loadTaskTemplates, saveTaskTemplates } from "./task-templates";
import type { RuntimeStorage } from "./types";

export const LOCAL_DATA_BACKUP_VERSION = 1;
const I18N_STORAGE_KEY = "easy-console-language";

export type LocalDataBackup = {
  app: "EasyConsole";
  version: typeof LOCAL_DATA_BACKUP_VERSION;
  exportedAt: string;
  includeSecrets: boolean;
  items: {
    settings?: unknown;
    language?: string;
    taskTemplates?: unknown[];
    resourcePresets?: unknown[];
    scheduledTasks?: unknown[];
    runLogs?: unknown[];
    token?: string;
    savedAccounts?: unknown[];
  };
};

export type LocalDataBackupSection = keyof LocalDataBackup["items"];

export type BackupStorageAdapters = {
  /** Ordinary settings / templates / schedules / logs. */
  storage: RuntimeStorage;
  /** Token + saved accounts (desktop keychain / secureStorage). Defaults to storage. */
  credentialStorage?: RuntimeStorage;
};

export const nonSecretBackupSections: LocalDataBackupSection[] = [
  "settings",
  "language",
  "taskTemplates",
  "resourcePresets",
  "scheduledTasks",
  "runLogs",
];

export const secretBackupSections: LocalDataBackupSection[] = ["token", "savedAccounts"];

function parseJsonArray(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveAdapters(input: RuntimeStorage | BackupStorageAdapters): Required<BackupStorageAdapters> {
  if ("get" in input && typeof (input as RuntimeStorage).get === "function" && !("storage" in input)) {
    const storage = input as RuntimeStorage;
    return { storage, credentialStorage: storage };
  }
  const adapters = input as BackupStorageAdapters;
  return {
    storage: adapters.storage,
    credentialStorage: adapters.credentialStorage ?? adapters.storage,
  };
}

export async function exportLocalDataBackup(
  storageOrAdapters: RuntimeStorage | BackupStorageAdapters,
  includeSecrets: boolean,
): Promise<LocalDataBackup> {
  const { storage, credentialStorage } = resolveAdapters(storageOrAdapters);
  const settingsRaw = await storage.get(APP_SETTINGS_STORAGE_KEY);
  const languageRaw = await storage.get(I18N_STORAGE_KEY);
  const tokenRaw = includeSecrets ? await credentialStorage.get(TOKEN_STORAGE_KEY) : null;
  const savedAccountsRaw = includeSecrets ? await credentialStorage.get(SAVED_ACCOUNTS_STORAGE_KEY) : null;
  return {
    app: "EasyConsole",
    version: LOCAL_DATA_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includeSecrets,
    items: {
      settings: parseAccountSettingsStore(settingsRaw),
      language: languageRaw ?? undefined,
      taskTemplates: await loadTaskTemplates(storage),
      resourcePresets: await loadResourcePresets(storage),
      scheduledTasks: await loadScheduledTasks(storage),
      runLogs: parseRunLogs(await storage.get(RUN_LOGS_STORAGE_KEY)),
      ...(includeSecrets
        ? {
            token: tokenRaw ?? undefined,
            savedAccounts: parseSavedAccounts(savedAccountsRaw),
          }
        : {}),
    },
  };
}

export function parseLocalDataBackup(text: string): LocalDataBackup {
  const parsed = JSON.parse(text) as Partial<LocalDataBackup>;
  if (parsed.app !== "EasyConsole" || parsed.version !== LOCAL_DATA_BACKUP_VERSION || !parsed.items || typeof parsed.items !== "object") {
    throw new Error(i18nText("非有效的 EasyConsole 备份数据文件", "Invalid EasyConsole backup file"));
  }
  return parsed as LocalDataBackup;
}

export function summarizeBackup(backup: LocalDataBackup) {
  return {
    hasSettings: Boolean(backup.items.settings),
    hasLanguage: typeof backup.items.language === "string",
    taskTemplates: Array.isArray(backup.items.taskTemplates) ? backup.items.taskTemplates.length : 0,
    resourcePresets: Array.isArray(backup.items.resourcePresets) ? backup.items.resourcePresets.length : 0,
    scheduledTasks: Array.isArray(backup.items.scheduledTasks) ? backup.items.scheduledTasks.length : 0,
    runLogs: Array.isArray(backup.items.runLogs) ? backup.items.runLogs.length : 0,
    hasToken: typeof backup.items.token === "string" && backup.items.token.length > 0,
    savedAccounts: Array.isArray(backup.items.savedAccounts) ? backup.items.savedAccounts.length : 0,
  };
}

/**
 * Sections the backup actually carries. A section the backup leaves out (an
 * older export without resource presets, a language-only file) is absent, not
 * empty: importing it must leave the local data alone rather than clear it.
 */
export function presentBackupSections(backup: LocalDataBackup): LocalDataBackupSection[] {
  const items = backup.items;
  const present: LocalDataBackupSection[] = [];
  if (items.settings && typeof items.settings === "object") present.push("settings");
  if (typeof items.language === "string") present.push("language");
  for (const section of ["taskTemplates", "resourcePresets", "scheduledTasks", "runLogs"] as const) {
    if (Array.isArray(items[section])) present.push(section);
  }
  if (typeof items.token === "string" && items.token) present.push("token");
  if (Array.isArray(items.savedAccounts)) present.push("savedAccounts");
  return present;
}

export type ImportLocalDataBackupOptions = {
  /**
   * Keep this install's API and monitor URLs instead of the backup's. Imports a
   * caller cannot vouch for (MCP) set it: the desktop applies the stored API URL
   * before it restores the keychain token, so an imported URL would send that
   * token to whatever host the backup names.
   */
  keepEndpoints?: boolean;
};

export async function importLocalDataBackup(
  storageOrAdapters: RuntimeStorage | BackupStorageAdapters,
  backup: LocalDataBackup,
  sections: LocalDataBackupSection[],
  options: ImportLocalDataBackupOptions = {},
) {
  const { storage, credentialStorage } = resolveAdapters(storageOrAdapters);
  const present = new Set(presentBackupSections(backup));
  // Selected but absent sections are skipped, never written as empty.
  const selected = new Set(sections.filter((section) => present.has(section)));
  if (selected.has("settings")) {
    const store = parseAccountSettingsStore(JSON.stringify(backup.items.settings));
    if (options.keepEndpoints) {
      const current = parseAccountSettingsStore(await storage.get(APP_SETTINGS_STORAGE_KEY));
      for (const [accountId, settings] of Object.entries(store.byAccount)) {
        // Endpoints come only from this install (or the built-in default), never the file.
        const kept = getAccountAppSettings(current, accountId);
        store.byAccount[accountId] = { ...settings, apiBaseUrl: kept.apiBaseUrl, monitorDashboardUrl: kept.monitorDashboardUrl };
      }
    }
    await storage.set(APP_SETTINGS_STORAGE_KEY, stringifyAccountSettingsStore(store));
  }
  if (selected.has("language")) {
    await storage.set(I18N_STORAGE_KEY, backup.items.language as string);
  }
  if (selected.has("taskTemplates")) {
    await saveTaskTemplates(storage, parseJsonArray(JSON.stringify(backup.items.taskTemplates)) as never);
  }
  if (selected.has("resourcePresets")) {
    await saveResourcePresets(storage, parseJsonArray(JSON.stringify(backup.items.resourcePresets)) as never);
  }
  if (selected.has("scheduledTasks")) {
    await saveScheduledTasks(storage, parseJsonArray(JSON.stringify(backup.items.scheduledTasks)) as never);
  }
  if (selected.has("runLogs")) {
    await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify(parseRunLogs(JSON.stringify(backup.items.runLogs))));
  }
  if (selected.has("token")) {
    await credentialStorage.set(TOKEN_STORAGE_KEY, backup.items.token as string);
  }
  if (selected.has("savedAccounts")) {
    await credentialStorage.set(
      SAVED_ACCOUNTS_STORAGE_KEY,
      stringifySavedAccounts(parseSavedAccounts(JSON.stringify(backup.items.savedAccounts))),
    );
  }
}

/** Resolve the active account settings from a backup/settings blob for UI apply. */
export function resolveBackupSettingsForAccount(settings: unknown, accountId = GLOBAL_SETTINGS_ACCOUNT_ID) {
  const store = parseAccountSettingsStore(JSON.stringify(settings ?? null));
  return getAccountAppSettings(store, accountId);
}
