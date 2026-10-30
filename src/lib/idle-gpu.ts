import type { IdleEvaluation } from "./idle-instance-reminder";

const MAX_SAMPLE_GAP_MS = 90_000;
const GPU_IDLE_PERCENT = 5;
type Sample = { at: number; max: number };
export type GpuIdleHistory = { devices: number; samples: Sample[] };

/** All devices must be observed throughout the window; gaps reset evidence. */
export function sampleGpuIdle(
  previous: GpuIdleHistory | undefined,
  values: number[] | null,
  now: number,
  windowMs: number,
): { history?: GpuIdleHistory; evaluation: IdleEvaluation } {
  if (!values?.length || values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    return { evaluation: "unknown" };
  }
  const last = previous?.samples.at(-1);
  const continuous = previous?.devices === values.length && last && now > last.at && now - last.at <= MAX_SAMPLE_GAP_MS;
  const samples = continuous ? previous.samples.filter((sample) => sample.at >= now - windowMs - MAX_SAMPLE_GAP_MS) : [];
  samples.push({ at: now, max: Math.max(...values) });
  const history = { devices: values.length, samples };
  const recent = samples.filter((sample) => sample.at >= now - windowMs);
  if (recent.some((sample) => sample.max > GPU_IDLE_PERCENT)) return { history, evaluation: "active" };
  const fullWindow = samples.length > 1 && samples[0].at <= now - windowMs;
  return { history, evaluation: fullWindow ? "idle" : "unknown" };
}
