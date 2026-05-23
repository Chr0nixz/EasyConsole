import { browserRuntime } from "./runtime";
import {
  buildMonitorDashboardUrl as buildMonitorDashboardUrlWithBase,
  DEFAULT_MONITOR_DASHBOARD_URL,
  getTaskPodName,
} from "./monitor-dashboard-core";
import type { Task } from "./types";

export { getTaskPodName };

export const MONITOR_DASHBOARD_URL =
  ((import.meta as ImportMeta & { env?: { VITE_MONITOR_DASHBOARD_URL?: string } }).env?.VITE_MONITOR_DASHBOARD_URL ||
    DEFAULT_MONITOR_DASHBOARD_URL);

export function buildMonitorDashboardUrl(task: Task) {
  return buildMonitorDashboardUrlWithBase(task, MONITOR_DASHBOARD_URL);
}

export function openMonitorDashboard(task: Task) {
  browserRuntime.openExternal(buildMonitorDashboardUrl(task));
}
