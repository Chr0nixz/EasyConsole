import type { RuntimeStorage, Task } from "./types";

export const TASK_PINS_STORAGE_KEY = "easy-console.taskPins";

export function getTaskPinId(task: Pick<Task, "id" | "task_id">) {
  return String(task.task_id ?? task.id);
}

export async function loadTaskPins(storage: RuntimeStorage) {
  const raw = await storage.get(TASK_PINS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  } catch {
    return [];
  }
}

export async function saveTaskPins(storage: RuntimeStorage, pinnedIds: string[]) {
  await storage.set(TASK_PINS_STORAGE_KEY, JSON.stringify(pinnedIds));
}

export function isTaskPinned(pinnedIds: string[], task: Pick<Task, "id" | "task_id">) {
  return pinnedIds.includes(getTaskPinId(task));
}

export function toggleTaskPin(pinnedIds: string[], task: Pick<Task, "id" | "task_id">) {
  const id = getTaskPinId(task);
  if (pinnedIds.includes(id)) {
    return pinnedIds.filter((item) => item !== id);
  }
  return [id, ...pinnedIds.filter((item) => item !== id)];
}

export function pruneTaskPins(pinnedIds: string[], tasks: Task[]) {
  const existing = new Set(tasks.map(getTaskPinId));
  return pinnedIds.filter((id) => existing.has(id));
}

export function sortTasksWithPins(tasks: Task[], pinnedIds: string[]) {
  if (pinnedIds.length === 0) return tasks;
  const order = new Map(pinnedIds.map((id, index) => [id, index]));
  return [...tasks].sort((left, right) => {
    const leftPin = order.get(getTaskPinId(left));
    const rightPin = order.get(getTaskPinId(right));
    if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
    if (leftPin !== undefined) return -1;
    if (rightPin !== undefined) return 1;
    return 0;
  });
}
