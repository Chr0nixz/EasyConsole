import { formatDateTimeForApi, formatDateTimeLocalInput } from "./format";
import type { CreateTaskPayload } from "./types";

export const SCHEDULED_RELEASE_DELAY_HOURS = 24;

export function getScheduledReleaseTime(scheduleTime: string) {
  const scheduledAt = Date.parse(scheduleTime);
  if (!Number.isFinite(scheduledAt)) return "";
  const releaseAt = new Date(scheduledAt + SCHEDULED_RELEASE_DELAY_HOURS * 60 * 60 * 1000);
  return formatDateTimeLocalInput(releaseAt).slice(0, 16);
}

export function applyScheduledReleasePolicy(payload: CreateTaskPayload, scheduleTime: string): CreateTaskPayload {
  if (Number(payload.releace_conditions) !== 2) return payload;
  const releaseTime = getScheduledReleaseTime(scheduleTime);
  return {
    ...payload,
    releace_time: releaseTime ? formatDateTimeForApi(releaseTime) : undefined,
  };
}
