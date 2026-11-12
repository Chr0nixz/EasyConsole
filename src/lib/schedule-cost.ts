import { SCHEDULED_RELEASE_DELAY_HOURS } from "./scheduled-release";
import { previewNextRuns, validateRecurrence } from "./task-recurrence";
import type { ScheduledTask, TaskRecurrence } from "./types";

/** Counting stops here, so a per-minute cron stays cheap to preview; a capped count reads "300+". */
export const FIRST_DAY_RUN_CAP = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many times a recurring plan runs inside its first 24 hours, counting the first run.
 * Null when the start time or the rule is invalid.
 */
export function countFirstDayRuns(scheduleTime: string, recurrence: TaskRecurrence): number | null {
  const first = new Date(scheduleTime);
  if (Number.isNaN(first.getTime())) return null;
  try {
    validateRecurrence(recurrence);
  } catch {
    return null;
  }
  const seed = { scheduleTime: first.toISOString(), lastRunAt: first.toISOString(), recurrence } as ScheduledTask;
  const runs = [first, ...previewNextRuns(seed, FIRST_DAY_RUN_CAP, first)];
  return Math.min(FIRST_DAY_RUN_CAP, runs.filter((run) => run.getTime() - first.getTime() < DAY_MS).length);
}

/**
 * What a plan bills, at the rate entered in the form. Only a timed release has a known
 * length (it fires `SCHEDULED_RELEASE_DELAY_HOURS` after each run), so only it gets a
 * figure; a manual release bills until someone releases it, and release-after-end bills
 * for as long as the script runs.
 */
export function estimateScheduleCost({
  rate,
  releaseCondition,
  runsPerDay,
}: {
  rate: number | null;
  releaseCondition: number;
  /** First-day runs for a recurring plan; null for a one-off plan. */
  runsPerDay: number | null;
}): { perRun: number | null; perDay: number | null } {
  if (rate === null || releaseCondition !== 2) return { perRun: null, perDay: null };
  const perRun = rate * SCHEDULED_RELEASE_DELAY_HOURS;
  return { perRun, perDay: runsPerDay === null ? null : perRun * runsPerDay };
}
