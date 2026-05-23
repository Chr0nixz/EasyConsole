import { browserRuntime } from "./runtime";
import {
  buildMonitorDashboardUrl as buildMonitorDashboardUrlWithBase,
  getTaskPodName,
} from "./monitor-dashboard-core";
import { getRuntimeSettings } from "./app-settings";
import type { Task } from "./types";

export { getTaskPodName };

export function buildMonitorDashboardUrl(task: Task) {
  return buildMonitorDashboardUrlWithBase(task, getRuntimeSettings().monitorDashboardUrl);
}

export function openMonitorDashboard(task: Task) {
  browserRuntime.openExternal(buildMonitorDashboardUrl(task));
}
