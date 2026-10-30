import { getTaskName } from "./format";
import type { Locale } from "./i18n-text";
import type { MonitorIndexResponse, MonitorMetricSeries, Task } from "./types";

export const DEFAULT_IDLE_REMINDER_WINDOW_MS = 120 * 60_000;

export const IDLE_REMINDER_WINDOW_OPTIONS = [
  { zh: "30 分钟", en: "30 min", value: 30 * 60_000 },
  { zh: "60 分钟", en: "60 min", value: 60 * 60_000 },
  { zh: "120 分钟", en: "120 min", value: 120 * 60_000 },
] as const;

/**
 * Heuristic thresholds. `monitor_index` exposes no GPU utilization (the
 * original console's monitor view is CPU/memory/network only), so idleness is
 * inferred from CPU percent and network rate here. Actual GPU samples are
 * collected separately over an existing SSH session. The network unit is unverified;
 * the constant assumes bytes/s and is deliberately generous.
 */
export const IDLE_CPU_THRESHOLD_PERCENT = 5;
export const IDLE_NETWORK_THRESHOLD_BPS = 10 * 1024;

/** The series must span at least this share of the window to judge idleness. */
const MIN_COVERAGE_RATIO = 0.5;

type IdlePoint = { timestampMs: number; value: number };

/**
 * The timestamp unit of `monitor_index` series is unverified; epoch seconds
 * (~1.7e9) and epoch milliseconds (~1.7e12) are separated by two orders of
 * magnitude, so anything below 1e11 is treated as seconds.
 */
function normalizeTimestampMs(timestamp: number) {
  return timestamp > 1e11 ? timestamp : timestamp * 1000;
}

function windowedPoints(series: MonitorMetricSeries | undefined, nowMs: number, windowMs: number): IdlePoint[] {
  if (!series?.data) return [];
  const from = nowMs - windowMs;
  const points: IdlePoint[] = [];
  for (const point of series.data) {
    const value = Number(point?.value);
    const timestamp = Number(point?.timestamp);
    if (!Number.isFinite(value) || !Number.isFinite(timestamp)) continue;
    const timestampMs = normalizeTimestampMs(timestamp);
    if (timestampMs >= from && timestampMs <= nowMs) points.push({ timestampMs, value });
  }
  points.sort((left, right) => left.timestampMs - right.timestampMs);
  return points;
}

export type IdleEvaluation = "idle" | "active" | "unknown";

/**
 * Judge whether an instance looks idle from its `monitor_index` series.
 *
 * "idle" needs the CPU series to cover at least half the window with every
 * point at or below the CPU threshold; a present network series must also stay
 * at or below its threshold. Any point above a threshold is "active"; missing
 * or too-thin data is "unknown" rather than a guess.
 */
export function evaluateIdleInstance(
  metrics: Pick<MonitorIndexResponse, "cpu" | "network">,
  nowMs: number,
  windowMs: number,
): IdleEvaluation {
  const cpu = (Array.isArray(metrics.cpu) ? metrics.cpu : []).map((series) => windowedPoints(series, nowMs, windowMs));
  const network = (Array.isArray(metrics.network) ? metrics.network : []).map((series) => windowedPoints(series, nowMs, windowMs));
  if (cpu.some((points) => points.some((point) => point.value > IDLE_CPU_THRESHOLD_PERCENT))) return "active";
  if (network.some((points) => points.some((point) => point.value > IDLE_NETWORK_THRESHOLD_BPS))) return "active";
  if (!cpu.length || cpu.some((points) => points.length < 2 || points.at(-1)!.timestampMs - points[0].timestampMs < windowMs * MIN_COVERAGE_RATIO)) return "unknown";
  return "idle";
}

/** Auto-release additionally needs current observations of both CPU and network. */
export function hasFreshIdleMetrics(metrics: Pick<MonitorIndexResponse, "cpu" | "network">, now: number, windowMs: number) {
  return [metrics.cpu, metrics.network].every((series, index) => Array.isArray(series) && series.length > 0 && series.every((item) => {
    const points = windowedPoints(item, now, windowMs);
    // Network units are unverified. Require zero for automatic actions, so
    // the reminder's generous heuristic threshold cannot authorize release.
    return points.length >= 2 && now - points.at(-1)!.timestampMs <= 90_000 && points.every((point) => point.value >= 0 && (index !== 1 || point.value === 0));
  }));
}

export type IdleInstanceReminder = {
  routeId: string;
  name: string;
  title: string;
  body: string;
  tag: string;
};

export function getIdleInstanceReminder(task: Task, locale: Locale, verifiedGpu = false): IdleInstanceReminder {
  const en = locale === "en-US";
  const name = getTaskName(task);
  const routeId = String(task.id ?? task.task_id);
  const taskId = String(task.task_id ?? task.id);
  return {
    routeId,
    name,
    title: en ? "Instance may be idle" : "实例可能闲置",
    body: verifiedGpu
      ? (en
        ? `${name}: GPU utilization, CPU and network have stayed low. GPU data was sampled through the connected SSH session.`
        : `${name}：GPU 利用率、CPU 与网络持续偏低。GPU 数据来自已连接的 SSH 会话采样。`)
      : en
      ? `${name}: CPU and network have stayed low. The platform exposes no GPU utilization, so this is a heuristic — check the monitor before releasing.`
      : `${name}：CPU 与网络持续偏低。平台接口不提供 GPU 利用率，此为启发式判断，释放前请先查看监控确认。`,
    tag: `easy-console-idle-${taskId}`,
  };
}
