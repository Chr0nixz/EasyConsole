import type { TaskStatus } from "./types";

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function formatTaskDefaultName(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;
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

export const taskStatusText: Record<number, string> = {
  0: "初始化",
  1: "队列中",
  2: "运行中",
  3: "暂停",
  4: "已释放",
  5: "耗尽",
  6: "成功",
  7: "失败",
  8: "异常",
};

export const releaseConditionText: Record<number, string> = {
  1: "手动释放",
  2: "定时释放",
  3: "任务结束释放",
};

export function getTaskName(task: { name?: string; task_name?: string; id?: string | number }) {
  return task.name || task.task_name || `任务 ${task.id ?? ""}`.trim();
}

export function getStatusText(status?: TaskStatus) {
  if (status === undefined || status === null) return "未知";
  return taskStatusText[Number(status)] ?? `状态 ${status}`;
}

export function getReleaseConditionText(condition?: number) {
  if (condition === undefined || condition === null) return "-";
  return releaseConditionText[Number(condition)] ?? `释放条件 ${condition}`;
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

export function formatNumber(value: unknown, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

export function formatCost(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatHours(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  if (number < 1) return `${Math.round(number * 60)} 分钟`;
  return `${number.toFixed(1)} 小时`;
}

export function formatSecondsDuration(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 分钟";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}
