import type { RuntimeStorage } from "./types";

export const CREATE_TASK_UI_PREFS_STORAGE_KEY = "easy-console.createTaskUiPrefs";

export type CreateTaskSectionId = "basic" | "resources" | "storage" | "release";

export type CreateTaskUiPrefs = {
  sections: Record<CreateTaskSectionId, boolean>;
  /** Whether the nested script env editor is expanded. */
  scriptEnvOpen: boolean;
  /**
   * When true (and release-after-task-ends), keep the instance name equal to EXPERIMENT_ID
   * in the form, then append a timestamp suffix on create. EXPERIMENT_ID itself is not numbered.
   */
  syncNameWithExperimentId: boolean;
  /**
   * The release condition each account last created with ("1" manual, "2" timed, "3" after the
   * task ends). A new create starts on it; an account with none starts on manual release.
   */
  lastReleaseConditionByAccount: Record<string, "1" | "2" | "3">;
};

export const DEFAULT_CREATE_TASK_UI_PREFS: CreateTaskUiPrefs = {
  sections: {
    basic: true,
    resources: true,
    storage: true,
    release: true,
  },
  scriptEnvOpen: false,
  syncNameWithExperimentId: false,
  lastReleaseConditionByAccount: {},
};

const SECTION_IDS: CreateTaskSectionId[] = ["basic", "resources", "storage", "release"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultPrefs(): CreateTaskUiPrefs {
  return { ...DEFAULT_CREATE_TASK_UI_PREFS, sections: { ...DEFAULT_CREATE_TASK_UI_PREFS.sections }, lastReleaseConditionByAccount: {} };
}

function parseLastReleaseConditions(value: unknown): Record<string, "1" | "2" | "3"> {
  if (!isRecord(value)) return {};
  const result: Record<string, "1" | "2" | "3"> = {};
  for (const [account, condition] of Object.entries(value)) {
    if (condition === "1" || condition === "2" || condition === "3") result[account] = condition;
  }
  return result;
}

/** The release condition a new create for `account` starts on: its last one, else manual. */
export function initialReleaseCondition(prefs: CreateTaskUiPrefs, account: string): "1" | "2" | "3" {
  return prefs.lastReleaseConditionByAccount[account] ?? "1";
}

export function withLastReleaseCondition(prefs: CreateTaskUiPrefs, account: string, condition: string): CreateTaskUiPrefs {
  if (!account || (condition !== "1" && condition !== "2" && condition !== "3")) return prefs;
  if (prefs.lastReleaseConditionByAccount[account] === condition) return prefs;
  return { ...prefs, lastReleaseConditionByAccount: { ...prefs.lastReleaseConditionByAccount, [account]: condition } };
}

export function parseCreateTaskUiPrefs(raw: string | null | undefined): CreateTaskUiPrefs {
  if (!raw) return defaultPrefs();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return defaultPrefs();
    const sectionsSource = isRecord(parsed.sections) ? parsed.sections : parsed;
    const sections = { ...DEFAULT_CREATE_TASK_UI_PREFS.sections };
    for (const id of SECTION_IDS) {
      if (typeof sectionsSource[id] === "boolean") sections[id] = sectionsSource[id];
    }
    return {
      sections,
      scriptEnvOpen: typeof parsed.scriptEnvOpen === "boolean" ? parsed.scriptEnvOpen : DEFAULT_CREATE_TASK_UI_PREFS.scriptEnvOpen,
      syncNameWithExperimentId:
        typeof parsed.syncNameWithExperimentId === "boolean"
          ? parsed.syncNameWithExperimentId
          : DEFAULT_CREATE_TASK_UI_PREFS.syncNameWithExperimentId,
      lastReleaseConditionByAccount: parseLastReleaseConditions(parsed.lastReleaseConditionByAccount),
    };
  } catch {
    return defaultPrefs();
  }
}

export async function loadCreateTaskUiPrefs(storage: RuntimeStorage) {
  return parseCreateTaskUiPrefs(await storage.get(CREATE_TASK_UI_PREFS_STORAGE_KEY));
}

export async function saveCreateTaskUiPrefs(storage: RuntimeStorage, prefs: CreateTaskUiPrefs) {
  await storage.set(CREATE_TASK_UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
}

/** Map form field error keys to create-task sections that should be opened. */
export function sectionsForFieldErrors(fieldErrors: Record<string, string>): CreateTaskSectionId[] {
  const open = new Set<CreateTaskSectionId>();
  if (fieldErrors.name || fieldErrors.image || fieldErrors.batchCount) open.add("basic");
  if (fieldErrors.cpu || fieldErrors.gpu || fieldErrors.memory || fieldErrors.price) open.add("resources");
  if (fieldErrors.storagePath || fieldErrors.mountPath) open.add("storage");
  if (fieldErrors.releaseTime || fieldErrors.workDirectory || fieldErrors.scriptPath || fieldErrors.scriptEnv) {
    open.add("release");
  }
  return Array.from(open);
}
