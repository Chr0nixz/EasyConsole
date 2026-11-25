import type { RuntimeStorage } from "./types";

/**
 * The row actions a user can pin to the task table's sticky action bar, beside the fixed
 * 释放 slot and More. Whatever is not on the bar stays in More; delete is never offered
 * here because it belongs apart, as More's last danger item.
 */
export const TASK_QUICK_ACTION_IDS = [
  "terminal",
  "log",
  "monitor",
  "clone",
  "extend",
  "edit",
  "commit",
  "download",
  "template",
  "pin",
  "raw",
] as const;

export type TaskQuickActionId = (typeof TASK_QUICK_ACTION_IDS)[number];

/** The bar every install started with: terminal, log, clone. */
export const DEFAULT_TASK_QUICK_ACTIONS: readonly TaskQuickActionId[] = ["terminal", "log", "clone"];

/** Six icons plus release and More stay inside the action column's 360px maximum. */
export const MAX_TASK_QUICK_ACTIONS = 6;

export const TASK_QUICK_ACTIONS_STORAGE_KEY = "easy-console.tasks.quickActions";

export const taskQuickActionLabels: Record<TaskQuickActionId, { zh: string; en: string }> = {
  terminal: { zh: "终端", en: "Terminal" },
  log: { zh: "日志", en: "Logs" },
  monitor: { zh: "监控", en: "Monitor" },
  clone: { zh: "克隆实例", en: "Clone instance" },
  extend: { zh: "延长释放", en: "Extend release" },
  edit: { zh: "编辑", en: "Edit" },
  commit: { zh: "提交镜像", en: "Commit image" },
  download: { zh: "下载", en: "Download" },
  template: { zh: "存为模板", en: "Save as template" },
  pin: { zh: "置顶 / 取消置顶", en: "Pin / Unpin" },
  raw: { zh: "原始 JSON", en: "Raw JSON" },
};

/** The bar with no quick actions: the 4rem release slot, the 2rem More trigger, a gap, and 12px cell padding each side. */
export const TASK_ACTION_STRIP_BASE_WIDTH = 124;
/** Each quick action adds a 2rem button and a 4px gap. */
export const TASK_QUICK_ACTION_SLOT_WIDTH = 36;

/** The action column width that fits `count` quick actions: 124px for none, 232px for the original three. */
export function taskActionStripWidth(count: number) {
  const slots = Math.max(0, Math.min(MAX_TASK_QUICK_ACTIONS, Math.floor(count)));
  return TASK_ACTION_STRIP_BASE_WIDTH + TASK_QUICK_ACTION_SLOT_WIDTH * slots;
}

export function isTaskQuickActionId(value: unknown): value is TaskQuickActionId {
  return typeof value === "string" && (TASK_QUICK_ACTION_IDS as readonly string[]).includes(value);
}

/**
 * Known ids in their saved order, without repeats, capped at the maximum. Anything that is
 * not a list falls back to the defaults; an empty list is a real choice (release and More only).
 */
export function normalizeTaskQuickActions(value: unknown): TaskQuickActionId[] {
  if (!Array.isArray(value)) return [...DEFAULT_TASK_QUICK_ACTIONS];
  const result: TaskQuickActionId[] = [];
  for (const item of value) {
    if (!isTaskQuickActionId(item) || result.includes(item)) continue;
    result.push(item);
    if (result.length === MAX_TASK_QUICK_ACTIONS) break;
  }
  return result;
}

export async function loadTaskQuickActions(storage: RuntimeStorage): Promise<TaskQuickActionId[]> {
  try {
    const raw = await storage.get(TASK_QUICK_ACTIONS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_TASK_QUICK_ACTIONS];
    return normalizeTaskQuickActions(JSON.parse(raw));
  } catch {
    return [...DEFAULT_TASK_QUICK_ACTIONS];
  }
}

export async function saveTaskQuickActions(storage: RuntimeStorage, actions: readonly TaskQuickActionId[]) {
  await storage.set(TASK_QUICK_ACTIONS_STORAGE_KEY, JSON.stringify(normalizeTaskQuickActions(actions)));
}

export function addTaskQuickAction(actions: readonly TaskQuickActionId[], id: TaskQuickActionId): TaskQuickActionId[] {
  if (actions.includes(id) || actions.length >= MAX_TASK_QUICK_ACTIONS) return [...actions];
  return [...actions, id];
}

export function removeTaskQuickAction(actions: readonly TaskQuickActionId[], id: TaskQuickActionId): TaskQuickActionId[] {
  return actions.filter((item) => item !== id);
}

/** Moves `id` one place toward the start (-1) or the end (1); a move past either end is a no-op. */
export function moveTaskQuickAction(
  actions: readonly TaskQuickActionId[],
  id: TaskQuickActionId,
  offset: -1 | 1,
): TaskQuickActionId[] {
  const index = actions.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= actions.length) return [...actions];
  const next = [...actions];
  next[index] = next[target];
  next[target] = id;
  return next;
}
