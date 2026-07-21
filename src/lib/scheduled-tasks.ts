import { computeNextRunTime, isRecurring } from "./task-recurrence";
import { updateStorageValue } from "./storage-mutex";
import type { CreateTaskPayload, RuntimeStorage, ScheduledTask, TaskRecurrence } from "./types";

export const SCHEDULED_TASKS_STORAGE_KEY = "easy-console.scheduledTasks";
export const STALE_LEASE_MS = 15 * 60 * 1000;

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

function normalizeRecurrence(raw: unknown): TaskRecurrence | undefined {
  if (!isRecord(raw)) return undefined;
  const type = String(raw.type ?? "");
  if (!["once", "daily", "weekly", "interval", "cron"].includes(type)) return undefined;
  const recurrence: TaskRecurrence = { type: type as TaskRecurrence["type"] };
  if (type === "weekly" && Array.isArray(raw.weekdays)) {
    recurrence.weekdays = raw.weekdays.filter((d) => typeof d === "number" && d >= 0 && d <= 6);
  }
  if (type === "interval" && typeof raw.intervalSec === "number") {
    recurrence.intervalSec = raw.intervalSec;
  }
  if (type === "cron" && typeof raw.cron === "string") {
    recurrence.cron = raw.cron;
  }
  if (typeof raw.endDate === "string") {
    recurrence.endDate = raw.endDate;
  }
  return recurrence;
}

function normalizeSchedule(raw: unknown): ScheduledTask | null {
  if (!isRecord(raw) || !isRecord(raw.payload)) return null;
  const id = String(raw.id ?? "");
  const name = String(raw.name ?? "");
  const scheduleTime = String(raw.scheduleTime ?? "");
  const status = String(raw.status ?? "pending");
  if (!id || !name || !scheduleTime || !["pending", "running", "done", "failed", "paused", "needs_review"].includes(status)) return null;
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
    recurrence: normalizeRecurrence(raw.recurrence),
    executionKey: typeof raw.executionKey === "string" ? raw.executionKey : undefined,
    leaseStartedAt: typeof raw.leaseStartedAt === "string" ? raw.leaseStartedAt : undefined,
    lastRemoteTaskId: typeof raw.lastRemoteTaskId === "string" ? raw.lastRemoteTaskId : undefined,
  };
}

export async function loadScheduledTasks(storage: RuntimeStorage) {
  const raw = await storage.get(SCHEDULED_TASKS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSchedule).filter((item): item is ScheduledTask => Boolean(item));
  } catch {
    return [];
  }
}

export async function saveScheduledTasks(storage: RuntimeStorage, items: ScheduledTask[]) {
  await updateStorageValue(storage, SCHEDULED_TASKS_STORAGE_KEY, () => JSON.stringify(items));
}

/** Atomic load→modify→save for scheduled task lists (used by background runner). */
export async function mutateScheduledTasks(
  storage: RuntimeStorage,
  updater: (items: ScheduledTask[]) => ScheduledTask[] | Promise<ScheduledTask[]>,
) {
  let next: ScheduledTask[] = [];
  await updateStorageValue(storage, SCHEDULED_TASKS_STORAGE_KEY, async (raw) => {
    let current: ScheduledTask[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          current = parsed.map(normalizeSchedule).filter((item): item is ScheduledTask => Boolean(item));
        }
      } catch {
        current = [];
      }
    }
    next = await updater(current);
    return JSON.stringify(next);
  });
  return next;
}

export function createScheduledTask(input: {
  name: string;
  description?: string;
  scheduleTime: string;
  payload: CreateTaskPayload;
  recurrence?: TaskRecurrence;
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
    recurrence: input.recurrence,
  };
}

export function isScheduleDue(task: ScheduledTask, now = new Date()) {
  if (task.status !== "pending") return false;

  if (!isRecurring(task)) {
    // One-time task: original logic
    const scheduledAt = Date.parse(task.scheduleTime);
    return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
  }

  // Recurring task: check if the next scheduled time has passed
  const nextRun = computeNextRunTime(task, now);
  if (!nextRun) return false;

  // For recurring tasks, the scheduleTime field is updated after each run to
  // the next run time. So we check if scheduleTime <= now.
  const scheduledAt = Date.parse(task.scheduleTime);
  return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
}

export function sortScheduledTasks(items: ScheduledTask[]) {
  return [...items].sort((left, right) => {
    const statusScore = (status: ScheduledTask["status"]) =>
      status === "pending" || status === "running" || status === "paused" || status === "needs_review" ? 0 : 1;
    return statusScore(left.status) - statusScore(right.status) || Date.parse(left.scheduleTime) - Date.parse(right.scheduleTime);
  });
}

export function updateScheduledTask(items: ScheduledTask[], next: ScheduledTask) {
  return items.map((item) => (item.id === next.id ? { ...next, updatedAt: nowIso() } : item));
}

export function pauseScheduledTask(task: ScheduledTask): ScheduledTask {
  if (task.status !== "pending") return task;
  return { ...task, status: "paused", updatedAt: nowIso() };
}

export function resumeScheduledTask(task: ScheduledTask): ScheduledTask {
  if (task.status !== "paused" && task.status !== "failed" && task.status !== "needs_review") return task;
  return {
    ...task,
    status: "pending",
    lastError: undefined,
    executionKey: undefined,
    leaseStartedAt: undefined,
    updatedAt: nowIso(),
  };
}

/**
 * After a recurring task completes, compute the next run time and reset
 * status to "pending". Returns the updated task, or null if the task
 * should not run again (e.g. past endDate).
 */
export function scheduleNextRun(task: ScheduledTask, now = new Date()): ScheduledTask | null {
  if (!isRecurring(task)) {
    return { ...task, status: "done" as const };
  }
  const nextRun = computeNextRunTime(task, now);
  if (!nextRun) {
    return { ...task, status: "done" as const };
  }
  return {
    ...task,
    status: "pending" as const,
    scheduleTime: nextRun.toISOString(),
    updatedAt: nowIso(),
  };
}

/**
 * Reconcile tasks stuck in "running" after a crash.
 * Stale leases become needs_review (never auto-replay createTask).
 */
export function resetStaleRunningTasks(items: ScheduledTask[], now = new Date(), staleMs = STALE_LEASE_MS): ScheduledTask[] {
  return items.map((item) => {
    if (item.status !== "running") return item;
    const started = item.leaseStartedAt ? Date.parse(item.leaseStartedAt) : NaN;
    const isStale = !Number.isFinite(started) || now.getTime() - started >= staleMs;
    if (!isStale) return item;
    return {
      ...item,
      status: "needs_review" as const,
      lastError:
        item.lastRemoteTaskId && item.executionKey
          ? `Lease expired after remote create (${item.lastRemoteTaskId}); confirm before replaying.`
          : "Lease expired while running; result unknown — confirm before replaying.",
      leaseStartedAt: undefined,
      updatedAt: nowIso(),
    };
  });
}
