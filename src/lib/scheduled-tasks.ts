import { ANONYMOUS_ACCOUNT_SCOPE_KEY, getActiveAccountScope } from "./account-scope";
import { i18nText } from "./i18n-text";
import { computeNextRunTime, isRecurring, validateRecurrence } from "./task-recurrence";
import { updateStorageValue } from "./storage-mutex";
import type { CreateTaskPayload, RuntimeStorage, ScheduledTask, ScheduledTaskOwner, TaskRecurrence } from "./types";

export const SCHEDULED_TASKS_STORAGE_KEY = "easy-console.scheduledTasks";
export const STALE_LEASE_MS = 15 * 60 * 1000;
export const LEGACY_SCHEDULED_TASK_OWNER_KEY = "legacy";

/** Owner marker for records created before account tracking existed. */
export const LEGACY_SCHEDULED_TASK_OWNER: ScheduledTaskOwner = {
  key: LEGACY_SCHEDULED_TASK_OWNER_KEY,
  displayName: "legacy/unknown",
};

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

/**
 * Parse a stored owner. Records from before account tracking have no owner
 * and are explicitly migrated to the legacy/unknown marker so the runner can
 * tell "unverifiable" apart from "belongs to the current account".
 */
function parseOwner(raw: unknown): ScheduledTaskOwner {
  if (isRecord(raw) && typeof raw.key === "string" && raw.key.trim()) {
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : raw.key;
    return { key: raw.key.trim(), displayName };
  }
  return LEGACY_SCHEDULED_TASK_OWNER;
}

/** Owner stamped on newly created schedules: the active account, or legacy when nobody is signed in. */
export function activeScheduleOwner(): ScheduledTaskOwner {
  const scope = getActiveAccountScope();
  if (scope.key === ANONYMOUS_ACCOUNT_SCOPE_KEY) return LEGACY_SCHEDULED_TASK_OWNER;
  return { key: scope.key, displayName: scope.displayName || scope.key };
}

function parseRecurrence(raw: unknown): TaskRecurrence | undefined {
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

function isInvalidRecurrence(recurrence: TaskRecurrence | undefined): boolean {
  if (!recurrence) return false;
  try {
    validateRecurrence(recurrence);
    return false;
  } catch {
    return true;
  }
}

/**
 * Coerce stored recurrence. Incomplete weekly/interval/cron configs are
 * degraded to a one-shot so `computeNextRunTime` cannot throw later.
 */
export function normalizeRecurrence(raw: unknown): { recurrence?: TaskRecurrence; invalid: boolean } {
  const recurrence = parseRecurrence(raw);
  if (!recurrence) return { recurrence: undefined, invalid: false };
  if (isInvalidRecurrence(recurrence)) {
    return { recurrence: { type: "once" }, invalid: true };
  }
  return { recurrence, invalid: false };
}

function normalizeSchedule(raw: unknown): ScheduledTask | null {
  if (!isRecord(raw) || !isRecord(raw.payload)) return null;
  const id = String(raw.id ?? "");
  const name = String(raw.name ?? "");
  const scheduleTime = String(raw.scheduleTime ?? "");
  let status = String(raw.status ?? "pending");
  if (!id || !name || !scheduleTime || !["pending", "running", "done", "failed", "paused", "needs_review"].includes(status)) return null;
  const { recurrence, invalid } = normalizeRecurrence(raw.recurrence);
  if (invalid && (status === "pending" || status === "running")) {
    status = "needs_review";
  }
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
    lastError: invalid
      ? typeof raw.lastError === "string" && raw.lastError
        ? raw.lastError
        : "Invalid recurrence configuration; confirm before running."
      : typeof raw.lastError === "string"
        ? raw.lastError
        : undefined,
    recurrence,
    executionKey: typeof raw.executionKey === "string" ? raw.executionKey : undefined,
    leaseStartedAt: typeof raw.leaseStartedAt === "string" ? raw.leaseStartedAt : undefined,
    lastRemoteTaskId: typeof raw.lastRemoteTaskId === "string" ? raw.lastRemoteTaskId : undefined,
    owner: parseOwner(raw.owner),
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
  owner?: ScheduledTaskOwner;
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
    owner: input.owner ?? activeScheduleOwner(),
  };
}

export function isScheduleDue(task: ScheduledTask, now = new Date()) {
  try {
    if (task.status !== "pending") return false;

    if (!isRecurring(task)) {
      const scheduledAt = Date.parse(task.scheduleTime);
      return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
    }

    const nextRun = computeNextRunTime(task, now);
    if (!nextRun) return false;

    const scheduledAt = Date.parse(task.scheduleTime);
    return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
  } catch {
    // A single corrupt recurrence must not abort the whole due-task loop.
    return false;
  }
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
  // Resuming is the user's explicit decision to run the task under the current
  // account: adopt it as owner. This is also the migration path for legacy or
  // other-account tasks that were held for review (scheduledTaskOwnerMismatch).
  const scope = getActiveAccountScope();
  const owner =
    scope.key === ANONYMOUS_ACCOUNT_SCOPE_KEY ? task.owner ?? LEGACY_SCHEDULED_TASK_OWNER : activeScheduleOwner();
  return {
    ...task,
    status: "pending",
    lastError: undefined,
    executionKey: undefined,
    leaseStartedAt: undefined,
    owner,
    updatedAt: nowIso(),
  };
}

/**
 * Whether the task may run under the current account. Returns a
 * human-readable reason when the owner cannot be verified; null when it can.
 */
export function scheduledTaskOwnerMismatch(
  task: ScheduledTask,
  scope = getActiveAccountScope(),
): { reason: string } | null {
  if (scope.key === ANONYMOUS_ACCOUNT_SCOPE_KEY) {
    return {
      reason: i18nText(
        "当前未登录，无法确认定时任务归属。请先登录创建该任务的账号，或在登录后恢复该任务以完成迁移。",
        "Not signed in, so this scheduled task's owner cannot be verified. Sign in with the creating account, or resume the task after signing in to migrate it.",
      ),
    };
  }
  const owner = task.owner ?? LEGACY_SCHEDULED_TASK_OWNER;
  if (owner.key === scope.key) return null;
  return {
    reason:
      owner.key === LEGACY_SCHEDULED_TASK_OWNER_KEY
        ? i18nText(
            "该定时任务由旧版本数据创建（创建账号未知），已暂停自动执行。请登录原账号，或在当前账号下点击“恢复”将其迁移后执行。",
            "This scheduled task predates account tracking (unknown creating account) and will not run automatically. Sign in with the original account, or resume it under the current account to migrate it.",
          )
        : i18nText(
            `该定时任务属于账号「${owner.displayName}」，与当前账号「${scope.displayName || scope.key}」不一致，已暂停自动执行。请切换到原账号，或在当前账号下点击“恢复”将其迁移后执行。`,
            `This scheduled task belongs to "${owner.displayName}" but the current account is "${scope.displayName || scope.key}"; it will not run automatically. Switch to the original account, or resume it under the current account to migrate it.`,
          ),
  };
}

/** Hold a task for user review without executing it remotely. */
export function holdScheduledTaskForReview(task: ScheduledTask, reason: string, now = new Date()): ScheduledTask {
  return {
    ...task,
    status: "needs_review",
    lastError: reason,
    leaseStartedAt: undefined,
    updatedAt: now.toISOString(),
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
