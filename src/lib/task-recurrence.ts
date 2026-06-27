import type { ScheduledTask, TaskRecurrence } from "./types";

/**
 * Lightweight 5-field cron next-run calculator.
 * Supports: asterisk, numbers, comma, dash (ranges).
 * Does NOT support: step values (e.g. star-slash-5), L, W, #, names.
 */

const CRON_FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0=Sun)
] as const;

function parseCronField(field: string, fieldIndex: number): Set<number> {
  const { min, max } = CRON_FIELDS[fieldIndex];
  const result = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i += 1) result.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(min, parseInt(rangeMatch[1], 10));
      const end = Math.min(max, parseInt(rangeMatch[2], 10));
      for (let i = start; i <= end; i += 1) result.add(i);
      continue;
    }
    const num = parseInt(part, 10);
    if (Number.isFinite(num) && num >= min && num <= max) {
      result.add(num);
    } else {
      throw new Error(`Invalid cron field "${field}" at position ${fieldIndex + 1}`);
    }
  }
  return result;
}

function parseCron(expr: string): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expression must have exactly 5 fields");
  return parts.map((p, i) => parseCronField(p, i)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
}

function nextCronTime(cron: string, after: Date): Date {
  const [minutes, hours, doms, months, dows] = parseCron(cron);
  const result = new Date(after);
  result.setSeconds(0, 0);
  // Search up to 366 days ahead
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    result.setMinutes(result.getMinutes() + 1);
    if (!months.has(result.getMonth() + 1)) continue;
    if (!doms.has(result.getDate()) && !dows.has(result.getDay())) continue;
    // cron standard: if both dom and dow are restricted (not *), match either.
    // We check: if dom field was * OR dow field was *, both must match.
    // Simplified: if either dom or dow matches, proceed (OR semantics).
    if (!minutes.has(result.getMinutes())) continue;
    if (!hours.has(result.getHours())) continue;
    return result;
  }
  throw new Error("No valid cron time found within 366 days");
}

/**
 * Compute the next run time for a scheduled task based on its recurrence.
 * Returns null if the task should not run again (e.g. past endDate).
 */
export function computeNextRunTime(task: ScheduledTask, now = new Date()): Date | null {
  const recurrence = task.recurrence;
  if (!recurrence || recurrence.type === "once") {
    // One-time: no next run
    return null;
  }

  // Check endDate
  if (recurrence.endDate) {
    const end = Date.parse(recurrence.endDate);
    if (Number.isFinite(end) && end <= now.getTime()) return null;
  }

  const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date(task.scheduleTime);
  const baseTime = lastRun > now ? lastRun : now;

  switch (recurrence.type) {
    case "daily": {
      // Next day at the same time as scheduleTime
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
      if (weekdays.length === 0) return null;
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
      if (intervalSec <= 0) return null;
      const next = new Date(baseTime.getTime() + intervalSec * 1000);
      return next > now ? next : new Date(now.getTime() + intervalSec * 1000);
    }
    case "cron": {
      if (!recurrence.cron) return null;
      return nextCronTime(recurrence.cron, now);
    }
    default:
      return null;
  }
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
