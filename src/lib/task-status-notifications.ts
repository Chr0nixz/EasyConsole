import { getStatusText, getTaskName } from "./format";
import type { Task, TaskStatus } from "./types";

export type ImportantTaskStatusNotification = {
  kind: "success" | "failure";
  taskId: string;
  title: string;
  body: string;
  tag: string;
};

const SUCCESS_STATUS = 6;
const FAILURE_STATUSES = new Set([7, 8]);

export function getTaskNotificationId(task: Pick<Task, "id" | "task_id">) {
  return String(task.task_id ?? task.id);
}

export function getImportantTaskStatusNotification(
  task: Task,
  previousStatus: TaskStatus | undefined,
): ImportantTaskStatusNotification | null {
  if (previousStatus === undefined || previousStatus === null || task.status === undefined || task.status === null) return null;

  const current = Number(task.status);
  const previous = Number(previousStatus);
  if (!Number.isFinite(current) || current === previous) return null;

  const taskId = getTaskNotificationId(task);
  if (current === SUCCESS_STATUS) {
    return {
      kind: "success",
      taskId,
      title: "实例运行成功",
      body: `${getTaskName(task)}：${getStatusText(task.status)}`,
      tag: `easy-console-task-${taskId}-${current}`,
    };
  }

  if (FAILURE_STATUSES.has(current)) {
    return {
      kind: "failure",
      taskId,
      title: "实例运行失败",
      body: `${getTaskName(task)}：${getStatusText(task.status)}`,
      tag: `easy-console-task-${taskId}-${current}`,
    };
  }

  return null;
}
