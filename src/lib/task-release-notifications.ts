import type { ImportantNotificationEvent } from "./app-settings";
import { formatSecondsDuration, getTaskReleaseCondition, getTaskName } from "./format";
import type { Locale } from "./i18n-text";
import type { Task } from "./types";

/** Backend release-condition code for a timed release (`releace_conditions === 2`). */
export const TIMED_RELEASE_CONDITION = 2;

/** Live statuses that can still be released (mirrors the tasks page's `isReleasableTask`). */
const RELEASABLE_STATUSES = new Set([0, 1, 2]);

/**
 * Parse `releace_time` into epoch ms. The original console stores local wall
 * clock time (`YYYY-MM-DD HH:mm:ss`, no zone marker), so the value is parsed
 * as local time; ISO strings with a zone still parse correctly.
 */
export function parseReleaseTime(task: Pick<Task, "releace_time">): number | null {
  const raw = task.releace_time;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Date.parse(raw.trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

/** When a live timed-release task will be released; null for every other task. */
export function getLiveTimedReleaseAt(task: Task): number | null {
  if (getTaskReleaseCondition(task) !== TIMED_RELEASE_CONDITION) return null;
  if (!RELEASABLE_STATUSES.has(Number(task.status))) return null;
  return parseReleaseTime(task);
}

/** "40 分钟后释放" — the time left before a timed release, rounded down to the minute. */
export function formatReleaseCountdown(remainingMs: number, locale: Locale): string {
  const en = locale === "en-US";
  if (remainingMs <= 0) return en ? "Release due" : "已到释放时间";
  if (remainingMs < 60_000) return en ? "Releases within 1 min" : "1 分钟内释放";
  const left = formatSecondsDuration(remainingMs / 1000, locale);
  return en ? `Releases in ${left}` : `${left}后释放`;
}

/** Format epoch ms the way the backend stores release times (local `YYYY-MM-DD HH:mm:ss`). */
export function formatReleaseTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export type TimedReleaseDueNotification = {
  event: ImportantNotificationEvent;
  /** The id the detail route uses (`/tasks/:id`), which is `task.id`, not `task_id`. */
  routeId: string;
  taskId: string;
  name: string;
  releaseAt: number;
  /** Reminds again when the release time changes (e.g. the task was extended). */
  dedupeKey: string;
  title: string;
  body: string;
  tag: string;
};

/**
 * A live timed-release task whose `releace_time` falls within the next
 * `leadMs`. Already-expired times do not qualify — the reminder is for tasks
 * the user can still extend.
 */
export function getUpcomingTimedReleaseNotification(
  task: Task,
  now: number,
  leadMs: number,
  locale: Locale,
): TimedReleaseDueNotification | null {
  const releaseAt = getLiveTimedReleaseAt(task);
  if (releaseAt === null) return null;
  const remaining = releaseAt - now;
  if (remaining <= 0 || remaining > leadMs) return null;

  const en = locale === "en-US";
  const name = getTaskName(task);
  const routeId = String(task.id ?? task.task_id);
  const taskId = String(task.task_id ?? task.id);
  const when = formatReleaseTimeInput(new Date(releaseAt));
  return {
    event: "task.releaseDue",
    routeId,
    taskId,
    name,
    releaseAt,
    dedupeKey: `${routeId}@${String(task.releace_time)}`,
    title: en ? "Timed release approaching" : "定时释放即将到期",
    body: en
      ? `${name}: releases at ${when}. Extend it from the task detail page if it is still needed.`
      : `${name}：将于 ${when} 释放，如仍需要请在任务详情页延长。`,
    tag: `easy-console-release-due-${taskId}-${String(task.releace_time)}`,
  };
}
