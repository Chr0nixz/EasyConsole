/** Durations a timed release offers, in hours, picked the way the extend dialog picks +1 / +3 / +24. */
export const TIMED_RELEASE_PRESET_HOURS = [2, 8, 24] as const;

export type ReleaseConditionValue = "1" | "2" | "3";

export function isReleaseConditionValue(value: unknown): value is ReleaseConditionValue {
  return value === "1" || value === "2" || value === "3";
}
