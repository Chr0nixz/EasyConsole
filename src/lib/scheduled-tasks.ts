import type { CreateTaskPayload, RuntimeStorage, ScheduledTask } from "./types";

export const SCHEDULED_TASKS_STORAGE_KEY = "easy-console.scheduledTasks";

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `schedule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeSchedule(raw: unknown): ScheduledTask | null {
  if (!isRecord(raw) || !isRecord(raw.payload)) return null;
  const id = String(raw.id ?? "");
  const name = String(raw.name ?? "");
  const scheduleTime = String(raw.scheduleTime ?? "");
  const status = String(raw.status ?? "pending");
  if (!id || !name || !scheduleTime || !["pending", "running", "done", "failed", "paused"].includes(status)) return null;
  return {
    id,
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    scheduleTime,
    status: status as ScheduledTask["status"],
    payload: raw.payload as CreateTaskPayload,
    createdAt: String(raw.createdAt ?? nowIso()),
    updatedAt: String(raw.updatedAt ?? nowIso()),
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
  };
}

export async function loadScheduledTasks(storage: RuntimeStorage) {
  const raw = await storage.get(SCHEDULED_TASKS_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeSchedule).filter((item): item is ScheduledTask => Boolean(item));
}

export function saveScheduledTasks(storage: RuntimeStorage, items: ScheduledTask[]) {
  return storage.set(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify(items));
}

export function createScheduledTask(input: {
  name: string;
  description?: string;
  scheduleTime: string;
  payload: CreateTaskPayload;
}): ScheduledTask {
  const timestamp = nowIso();
  return {
    id: makeId(),
    name: input.name,
    description: input.description,
    scheduleTime: input.scheduleTime,
    status: "pending",
    payload: input.payload,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isScheduleDue(task: ScheduledTask, now = new Date()) {
  if (task.status !== "pending") return false;
  const scheduledAt = Date.parse(task.scheduleTime);
  return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
}

export function sortScheduledTasks(items: ScheduledTask[]) {
  return [...items].sort((left, right) => {
    const statusScore = (status: ScheduledTask["status"]) => (status === "pending" || status === "running" ? 0 : 1);
    return statusScore(left.status) - statusScore(right.status) || Date.parse(left.scheduleTime) - Date.parse(right.scheduleTime);
  });
}

export function updateScheduledTask(items: ScheduledTask[], next: ScheduledTask) {
  return items.map((item) => (item.id === next.id ? { ...next, updatedAt: nowIso() } : item));
}
