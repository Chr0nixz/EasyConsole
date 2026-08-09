import type { RuntimeStorage } from "./types";

export const CREATE_TASK_UI_PREFS_STORAGE_KEY = "easy-console.createTaskUiPrefs";

export type CreateTaskSectionId = "basic" | "resources" | "storage" | "release";

export type CreateTaskUiPrefs = {
  sections: Record<CreateTaskSectionId, boolean>;
  /** Whether the nested script env editor is expanded. */
  scriptEnvOpen: boolean;
};

export const DEFAULT_CREATE_TASK_UI_PREFS: CreateTaskUiPrefs = {
  sections: {
    basic: true,
    resources: true,
    storage: true,
    release: true,
  },
  scriptEnvOpen: false,
};

const SECTION_IDS: CreateTaskSectionId[] = ["basic", "resources", "storage", "release"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCreateTaskUiPrefs(raw: string | null | undefined): CreateTaskUiPrefs {
  if (!raw) return { ...DEFAULT_CREATE_TASK_UI_PREFS, sections: { ...DEFAULT_CREATE_TASK_UI_PREFS.sections } };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { ...DEFAULT_CREATE_TASK_UI_PREFS, sections: { ...DEFAULT_CREATE_TASK_UI_PREFS.sections } };
    }
    const sectionsSource = isRecord(parsed.sections) ? parsed.sections : parsed;
    const sections = { ...DEFAULT_CREATE_TASK_UI_PREFS.sections };
    for (const id of SECTION_IDS) {
      if (typeof sectionsSource[id] === "boolean") sections[id] = sectionsSource[id];
    }
    return {
      sections,
      scriptEnvOpen: typeof parsed.scriptEnvOpen === "boolean" ? parsed.scriptEnvOpen : DEFAULT_CREATE_TASK_UI_PREFS.scriptEnvOpen,
    };
  } catch {
    return { ...DEFAULT_CREATE_TASK_UI_PREFS, sections: { ...DEFAULT_CREATE_TASK_UI_PREFS.sections } };
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
