import type { TaskStatus, UnknownRecord } from "./types";
import { i18nText, type Locale } from "./i18n-text";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatTaskDefaultName(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/**
 * Default name for a clone: the source's own name with a fresh timestamp, so reruns of one
 * experiment stay together in the list. The source's old timestamp (and a template marker or
 * batch number around it) is dropped first; a source that was only a timestamp gets a new one.
 */
export function formatCloneTaskName(sourceName: string | undefined | null, date = new Date()) {
  const stem = (sourceName ?? "").trim().replace(/(?:-tpl[a-zA-Z0-9]{1,10})?(?:^|[-_])\d{12}(?:-\d+)?$/, "");
  return stem ? `${stem}-${formatTaskDefaultName(date)}` : formatTaskDefaultName(date);
}

/** Instance name derived from EXPERIMENT_ID plus a minute-resolution timestamp suffix. */
export function formatExperimentTimedTaskName(experimentId: string, date = new Date()) {
  const id = experimentId.trim();
  if (!id) return "";
  return `${id}_${formatTaskDefaultName(date)}`;
}

export function formatDateTimeForApi(value: string) {
  if (!value) return "";
  const normalized = value.replace("T", " ");
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

export function formatDateTimeLocalInput(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

/** A string that exists in both supported interface languages. */
export type LocalizedText = { zh: string; en: string };

/**
 * Look up a value in a `{ zh, en }` map. Keeping the pair together rather than
 * in two parallel maps means the languages cannot drift apart.
 */
export function localizedText(value: LocalizedText | undefined, locale: Locale): string | undefined {
  if (!value) return undefined;
  return locale === "en-US" ? value.en : value.zh;
}

export const taskStatusText: Record<number, LocalizedText> = {
  0: { zh: "初始化", en: "Initializing" },
  1: { zh: "队列中", en: "Queued" },
  2: { zh: "运行中", en: "Running" },
  3: { zh: "暂停", en: "Paused" },
  4: { zh: "已释放", en: "Released" },
  5: { zh: "耗尽", en: "Exhausted" },
  6: { zh: "成功", en: "Succeeded" },
  7: { zh: "失败", en: "Failed" },
  8: { zh: "异常", en: "Abnormal" },
};

export const releaseConditionText: Record<number, LocalizedText> = {
  1: { zh: "手动释放", en: "Manual release" },
  2: { zh: "定时释放", en: "Timed release" },
  3: { zh: "任务结束释放", en: "Release after task ends" },
};

/**
 * Display name for a task. Most callers are non-React helpers (`task-search`,
 * `task-list-query`) that have no locale in scope, so the fallback goes through
 * `i18nText` rather than taking a locale parameter.
 */
export function getTaskName(task: { name?: string; task_name?: string; id?: string | number }) {
  const id = task.id ?? "";
  return task.name || task.task_name || i18nText(`任务 ${id}`.trim(), `Task ${id}`.trim());
}

export function getTaskNodeName(task: UnknownRecord & {
  node?: UnknownRecord & { name?: string };
  node_name?: string;
}) {
  const node = task.node && typeof task.node === "object" ? task.node : undefined;
  return node?.name || task.node_name || "";
}

export function getStatusText(status?: TaskStatus, locale: Locale = "zh-CN") {
  if (status === undefined || status === null) return locale === "en-US" ? "Unknown" : "未知";
  return localizedText(taskStatusText[Number(status)], locale) ?? (locale === "en-US" ? `Status ${status}` : `状态 ${status}`);
}

export function getReleaseConditionText(condition?: number, locale: Locale = "zh-CN") {
  if (condition === undefined || condition === null) return "-";
  return localizedText(releaseConditionText[Number(condition)], locale) ?? (locale === "en-US" ? `Release condition ${condition}` : `释放条件 ${condition}`);
}

/** Backend spelling is `releace_conditions`; keep `release_condition` as a fallback. */
export function getTaskReleaseCondition(task: {
  releace_conditions?: number | string;
  release_condition?: number | string;
}) {
  const raw = task.releace_conditions ?? task.release_condition;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function formatBytes(value?: number) {
  if (!value || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function asJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function formatNumber(value: unknown, digits = 0, locale: Locale = "zh-CN") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

/** A billed amount with its unit: the backend bills in 元 (the original console labels every cost so). */
export function formatCost(value: unknown, locale: Locale = "zh-CN") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const amount = number.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return locale === "en-US" ? `CNY ${amount}` : `${amount} 元`;
}

/** An hourly rate with its unit ("48.00 元/小时"). Up to four decimals, so an entered rate is never rounded away. */
export function formatHourlyRate(value: unknown, locale: Locale = "zh-CN") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const amount = number.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  return locale === "en-US" ? `CNY ${amount}/hr` : `${amount} 元/小时`;
}

export function formatHours(value: unknown, locale: Locale = "zh-CN") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number < 1) return locale === "en-US" ? `${Math.round(number * 60)} min` : `${Math.round(number * 60)} 分钟`;
  return locale === "en-US" ? `${number.toFixed(1)} hr` : `${number.toFixed(1)} 小时`;
}

export function formatSecondsDuration(value: unknown, locale: Locale = "zh-CN") {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return locale === "en-US" ? "0 min" : "0 分钟";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (locale === "en-US") {
    if (days > 0) return `${days} d ${hours} hr`;
    if (hours > 0) return `${hours} hr ${minutes} min`;
    return `${minutes} min`;
  }
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

const BACKEND_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const ZONED_DATE_TIME = /(?:z|[+-]\d{2}:?\d{2})$/i;

function wallClockParts(raw: string): [string, string, string, string, string, string] | null {
  const text = raw.trim();
  if (!text) return null;
  const wall = BACKEND_WALL_CLOCK.exec(text);
  if (wall) return [wall[1], wall[2], wall[3], wall[4], wall[5], wall[6] ?? "00"];
  if (!ZONED_DATE_TIME.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ];
}

/**
 * A backend timestamp as `YYYY-MM-DD HH:mm:ss`. The backend's own wall-clock text is kept as
 * it is (no zone is assumed for it); a zoned ISO value is shown in this machine's time.
 * Anything else comes back unchanged, so an unexpected format is still visible.
 */
export function formatBackendDateTime(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "-";
  const parts = wallClockParts(value);
  if (!parts) return value;
  const [year, month, day, hour, minute, second] = parts;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** The short form for a row's second line: `MM-DD HH:mm`, with the year only when it is not this year's. */
export function formatCompactBackendDateTime(value: unknown, now = new Date()): string | null {
  if (typeof value !== "string") return null;
  const parts = wallClockParts(value);
  if (!parts) return null;
  const [year, month, day, hour, minute] = parts;
  const date = `${month}-${day} ${hour}:${minute}`;
  return Number(year) === now.getFullYear() ? date : `${year}-${date}`;
}

export function formatRelativeUpdatedAt(updatedAt: number, now: number, locale: Locale = "zh-CN") {
  const deltaMs = Math.max(0, now - updatedAt);
  const en = locale === "en-US";
  if (deltaMs < 5_000) return en ? "Just now" : "刚刚";
  if (deltaMs < 60_000) {
    const seconds = Math.max(1, Math.floor(deltaMs / 1_000));
    return en ? `${seconds}s ago` : `${seconds} 秒前`;
  }
  if (deltaMs < 3_600_000) {
    const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
    return en ? `${minutes}m ago` : `${minutes} 分钟前`;
  }
  if (deltaMs < 86_400_000) {
    const hours = Math.max(1, Math.floor(deltaMs / 3_600_000));
    return en ? `${hours}h ago` : `${hours} 小时前`;
  }
  const days = Math.max(1, Math.floor(deltaMs / 86_400_000));
  return en ? `${days}d ago` : `${days} 天前`;
}
