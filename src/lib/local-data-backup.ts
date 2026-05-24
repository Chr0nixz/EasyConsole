import { TOKEN_STORAGE_KEY } from "./api-client";
import { APP_SETTINGS_STORAGE_KEY, parseAppSettings, stringifyAppSettings } from "./app-settings";
import { RUN_LOGS_STORAGE_KEY, parseRunLogs } from "./run-logs";
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
    scheduledTasks?: unknown[];
    runLogs?: unknown[];
    token?: string;
    savedAccounts?: unknown[];
  };
};

export type LocalDataBackupSection = keyof LocalDataBackup["items"];

export const nonSecretBackupSections: LocalDataBackupSection[] = [
  "settings",
  "language",
  "taskTemplates",
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

export async function exportLocalDataBackup(storage: RuntimeStorage, includeSecrets: boolean): Promise<LocalDataBackup> {
  const settingsRaw = await storage.get(APP_SETTINGS_STORAGE_KEY);
  const languageRaw = await storage.get(I18N_STORAGE_KEY);
  const tokenRaw = await storage.get(TOKEN_STORAGE_KEY);
  const savedAccountsRaw = await storage.get(SAVED_ACCOUNTS_STORAGE_KEY);
  return {
    app: "EasyConsole",
    version: LOCAL_DATA_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includeSecrets,
    items: {
      settings: parseAppSettings(settingsRaw),
      language: languageRaw ?? undefined,
      taskTemplates: await loadTaskTemplates(storage),
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
    throw new Error("Unsupported EasyConsole backup file");
  }
  return parsed as LocalDataBackup;
}

export function summarizeBackup(backup: LocalDataBackup) {
  return {
    hasSettings: Boolean(backup.items.settings),
    hasLanguage: typeof backup.items.language === "string",
    taskTemplates: Array.isArray(backup.items.taskTemplates) ? backup.items.taskTemplates.length : 0,
    scheduledTasks: Array.isArray(backup.items.scheduledTasks) ? backup.items.scheduledTasks.length : 0,
    runLogs: Array.isArray(backup.items.runLogs) ? backup.items.runLogs.length : 0,
    hasToken: typeof backup.items.token === "string" && backup.items.token.length > 0,
    savedAccounts: Array.isArray(backup.items.savedAccounts) ? backup.items.savedAccounts.length : 0,
  };
}

export async function importLocalDataBackup(storage: RuntimeStorage, backup: LocalDataBackup, sections: LocalDataBackupSection[]) {
  const selected = new Set(sections);
  if (selected.has("settings") && backup.items.settings) {
    await storage.set(APP_SETTINGS_STORAGE_KEY, stringifyAppSettings(backup.items.settings));
  }
  if (selected.has("language") && typeof backup.items.language === "string") {
    await storage.set(I18N_STORAGE_KEY, backup.items.language);
  }
  if (selected.has("taskTemplates")) {
    await saveTaskTemplates(storage, parseJsonArray(JSON.stringify(backup.items.taskTemplates ?? [])) as never);
  }
  if (selected.has("scheduledTasks")) {
    await saveScheduledTasks(storage, parseJsonArray(JSON.stringify(backup.items.scheduledTasks ?? [])) as never);
  }
  if (selected.has("runLogs")) {
    await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify(parseRunLogs(JSON.stringify(backup.items.runLogs ?? []))));
  }
  if (selected.has("token") && backup.items.token) {
    await storage.set(TOKEN_STORAGE_KEY, backup.items.token);
  }
  if (selected.has("savedAccounts")) {
    await storage.set(SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts(parseSavedAccounts(JSON.stringify(backup.items.savedAccounts ?? []))));
  }
}
