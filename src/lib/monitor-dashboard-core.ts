import type { Task } from "./types";

export const DEFAULT_MONITOR_DASHBOARD_URL =
  "http://116.172.93.164:33000/d/da7c4fef-70c7-43eb-8103-31b7d283ca9f/pod-board?orgId=1";

const podNameFields = ["description", "pod_name", "podName", "pod", "k8s_pod_name", "k8sPodName"];

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function getTaskPodName(task: Task) {
  return (
    firstText(...podNameFields.map((field) => task[field]), task.name, task.task_name, task.task_id, task.id) ||
    String(task.task_id ?? task.id)
  );
}

export function buildMonitorDashboardUrl(task: Task, dashboardUrl = DEFAULT_MONITOR_DASHBOARD_URL) {
  const url = new URL(dashboardUrl);
  url.searchParams.set("var-pod", getTaskPodName(task));
  return url.toString();
}
