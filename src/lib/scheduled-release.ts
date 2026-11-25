import { formatDateTimeForApi, formatDateTimeLocalInput } from "./format";
import type { CreateTaskPayload } from "./types";

export const SCHEDULED_RELEASE_DELAY_HOURS = 24;

/**
 * Release moment of a timed-release run that starts at `runStartsAt`. Execution
 * passes the moment it submits; the plan form passes the planned slot, which is
 * the same moment for a run that starts on time.
 */
export function getScheduledReleaseTime(runStartsAt: string | Date) {
  const startsAt = runStartsAt instanceof Date ? runStartsAt.getTime() : Date.parse(runStartsAt);
  if (!Number.isFinite(startsAt)) return "";
  const releaseAt = new Date(startsAt + SCHEDULED_RELEASE_DELAY_HOURS * 60 * 60 * 1000);
  return formatDateTimeLocalInput(releaseAt).slice(0, 16);
}

export function applyScheduledReleasePolicy(payload: CreateTaskPayload, runStartsAt: string | Date): CreateTaskPayload {
  if (Number(payload.releace_conditions) !== 2) return payload;
  const releaseTime = getScheduledReleaseTime(runStartsAt);
  return {
    ...payload,
    releace_time: releaseTime ? formatDateTimeForApi(releaseTime) : undefined,
  };
}
