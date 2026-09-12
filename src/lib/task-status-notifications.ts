import { getStatusText, getTaskName } from "./format";
import type { Locale } from "./i18n-text";
import type { ImportantNotificationEvent } from "./app-settings";
import type { Task, TaskStatus } from "./types";

export type ImportantTaskStatusNotification = {
  kind: "success" | "failure";
  event: ImportantNotificationEvent;
  taskId: string;
  title: string;
  body: string;
  tag: string;
};

const SUCCESS_STATUS = 6;
/** Failed (7) and abnormal (8) — promote log access in the task action strip. */
export const FAILURE_STATUSES = new Set([7, 8]);

export function getTaskNotificationId(task: Pick<Task, "id" | "task_id">) {
  return String(task.task_id ?? task.id);
}

export function needsLogAttention(task: Pick<Task, "status">) {
  const status = Number(task.status);
  return Number.isFinite(status) && FAILURE_STATUSES.has(status);
}

export function getImportantTaskStatusNotification(
  task: Task,
  previousStatus: TaskStatus | undefined,
  locale: Locale,
): ImportantTaskStatusNotification | null {
  if (previousStatus === undefined || previousStatus === null || task.status === undefined || task.status === null) return null;

  const current = Number(task.status);
  const previous = Number(previousStatus);
  if (!Number.isFinite(current) || current === previous) return null;

  const taskId = getTaskNotificationId(task);
  const en = locale === "en-US";
  // Task names are user data; only the separator follows the interface language.
  const body = `${getTaskName(task)}${en ? ": " : "："}${getStatusText(task.status, locale)}`;

  if (current === SUCCESS_STATUS) {
    return {
      kind: "success",
      event: "task.success",
      taskId,
      title: en ? "Instance succeeded" : "实例运行成功",
      body,
      tag: `easy-console-task-${taskId}-${current}`,
    };
  }

  if (FAILURE_STATUSES.has(current)) {
    const abnormal = current === 8;
    return {
      kind: "failure",
      event: abnormal ? "task.abnormal" : "task.failure",
      taskId,
      title: abnormal ? (en ? "Instance abnormal" : "实例运行异常") : en ? "Instance failed" : "实例运行失败",
      body,
      tag: `easy-console-task-${taskId}-${current}`,
    };
  }

  return null;
}
