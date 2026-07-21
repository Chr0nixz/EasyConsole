import { Cron } from "croner";

import type { ScheduledTask, TaskRecurrence } from "./types";

export class RecurrenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceValidationError";
  }
}

/** Validate cron expression; throws RecurrenceValidationError on failure. */
export function assertValidCron(expr: string) {
  const trimmed = expr.trim();
  if (!trimmed) throw new RecurrenceValidationError("Cron expression is required");
  try {
    // croner uses local timezone by default; catch invalid patterns early.
    // eslint-disable-next-line no-new
    new Cron(trimmed, { paused: true });
  } catch (error) {
    throw new RecurrenceValidationError(error instanceof Error ? error.message : "Invalid cron expression");
  }
}

export function validateRecurrence(recurrence: TaskRecurrence | undefined): void {
  if (!recurrence || recurrence.type === "once") return;
  if (recurrence.type === "weekly") {
    const weekdays = recurrence.weekdays ?? [];
    if (weekdays.length === 0) {
      throw new RecurrenceValidationError("Weekly recurrence requires at least one weekday");
    }
    if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new RecurrenceValidationError("Weekdays must be integers from 0 (Sun) to 6 (Sat)");
    }
  }
  if (recurrence.type === "interval") {
    if (!recurrence.intervalSec || recurrence.intervalSec <= 0) {
      throw new RecurrenceValidationError("Interval recurrence requires a positive intervalSec");
    }
  }
  if (recurrence.type === "cron") {
    if (!recurrence.cron?.trim()) throw new RecurrenceValidationError("Cron expression is required");
    assertValidCron(recurrence.cron);
  }
}

function nextCronTime(cron: string, after: Date): Date {
  assertValidCron(cron);
  const job = new Cron(cron.trim());
  const next = job.nextRun(after);
  if (!next) throw new RecurrenceValidationError("No valid cron time found");
  return next;
}

/**
 * Compute the next run time for a scheduled task based on its recurrence.
 * Returns null if the task should not run again (e.g. past endDate / once).
 * Throws RecurrenceValidationError for invalid weekly/cron configuration.
 */
export function computeNextRunTime(task: ScheduledTask, now = new Date()): Date | null {
  const recurrence = task.recurrence;
  if (!recurrence || recurrence.type === "once") {
    return null;
  }

  validateRecurrence(recurrence);

  if (recurrence.endDate) {
    const end = Date.parse(recurrence.endDate);
    if (Number.isFinite(end) && end <= now.getTime()) return null;
  }

  const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date(task.scheduleTime);
  const baseTime = lastRun > now ? lastRun : now;

  switch (recurrence.type) {
    case "daily": {
      const scheduledTime = new Date(task.scheduleTime);
      const next = new Date(baseTime);
      next.setHours(scheduledTime.getHours(), scheduledTime.getMinutes(), 0, 0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
    case "weekly": {
      const weekdays = recurrence.weekdays ?? [];
      const scheduledTime = new Date(task.scheduleTime);
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = new Date(baseTime);
        candidate.setDate(candidate.getDate() + offset);
        candidate.setHours(scheduledTime.getHours(), scheduledTime.getMinutes(), 0, 0);
        if (candidate <= now) continue;
        if (weekdays.includes(candidate.getDay())) return candidate;
      }
      return null;
    }
    case "interval": {
      const intervalSec = recurrence.intervalSec ?? 0;
      const next = new Date(baseTime.getTime() + intervalSec * 1000);
      return next > now ? next : new Date(now.getTime() + intervalSec * 1000);
    }
    case "cron": {
      return nextCronTime(recurrence.cron!, now);
    }
    default:
      return null;
  }
}

/** Preview the next N trigger times for UI / dry-run. */
export function previewNextRuns(task: ScheduledTask, count = 5, now = new Date()): Date[] {
  const results: Date[] = [];
  let cursor = new Date(now);
  let current: ScheduledTask = { ...task };

  for (let i = 0; i < count; i += 1) {
    const next = computeNextRunTime(current, cursor);
    if (!next) break;
    results.push(next);
    current = {
      ...current,
      lastRunAt: next.toISOString(),
      scheduleTime: next.toISOString(),
    };
    cursor = next;
  }
  return results;
}

export function isRecurring(task: ScheduledTask): boolean {
  return Boolean(task.recurrence && task.recurrence.type !== "once");
}

export function describeRecurrence(recurrence: TaskRecurrence): string {
  switch (recurrence.type) {
    case "once":
      return "单次";
    case "daily":
      return "每天";
    case "weekly": {
      const days = ["日", "一", "二", "三", "四", "五", "六"];
      const labels = (recurrence.weekdays ?? []).sort().map((d) => `周${days[d] ?? d}`);
      return labels.length > 0 ? labels.join("、") : "每周";
    }
    case "interval": {
      const sec = recurrence.intervalSec ?? 0;
      if (sec >= 86400) return `每 ${Math.floor(sec / 86400)} 天`;
      if (sec >= 3600) return `每 ${Math.floor(sec / 3600)} 小时`;
      if (sec >= 60) return `每 ${Math.floor(sec / 60)} 分钟`;
      return `每 ${sec} 秒`;
    }
    case "cron":
      return `Cron: ${recurrence.cron ?? "?"}`;
    default:
      return "未知";
  }
}
