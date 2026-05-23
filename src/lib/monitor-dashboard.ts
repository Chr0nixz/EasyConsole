import type { Task } from "./types";

export const MONITOR_DASHBOARD_URL =
  import.meta.env.VITE_MONITOR_DASHBOARD_URL || "http://116.172.93.164:33000/d/da7c4fef-70c7-43eb-8103-31b7d283ca9f/pod-board?orgId=1";

export function getTaskPodName(task: Task) {
  return task.description || task.name || task.task_name || String(task.task_id ?? task.id);
}

export function buildMonitorDashboardUrl(task: Task) {
  const url = new URL(MONITOR_DASHBOARD_URL);
  url.searchParams.set("var-pod", getTaskPodName(task));
  return url.toString();
}

export function openMonitorDashboard(task: Task) {
  window.open(buildMonitorDashboardUrl(task), "_blank", "noopener,noreferrer");
}
