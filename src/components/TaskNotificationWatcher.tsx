import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { browserRuntime } from "../lib/runtime";
import { getImportantTaskStatusNotification, getTaskNotificationId, type ImportantTaskStatusNotification } from "../lib/task-status-notifications";
import type { TaskStatus } from "../lib/types";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";

const TASK_NOTIFICATION_WATCH_INTERVAL = 10_000;
const TASK_NOTIFICATION_PAGE_SIZE = 100;

export function TaskNotificationWatcher() {
  const auth = useAuth();
  const toast = useToast();
  const initializedRef = useRef(false);
  const statusSnapshotRef = useRef<Map<string, TaskStatus | undefined>>(new Map());
  const permissionWarningRef = useRef<"permission-denied" | "unsupported" | null>(null);

  const query = useQuery({
    queryKey: ["task-notification-watch"],
    queryFn: () => instanceApi.tasks({ page: 1, page_size: TASK_NOTIFICATION_PAGE_SIZE }),
    enabled: Boolean(auth.token),
    refetchInterval: TASK_NOTIFICATION_WATCH_INTERVAL,
    refetchIntervalInBackground: true,
  });

  const showInAppNotification = useCallback((notification: ImportantTaskStatusNotification) => {
    const notify = notification.kind === "failure" ? toast.error : toast.success;
    notify(notification.title, notification.body);
  }, [toast]);

  useEffect(() => {
    if (!auth.token) {
      initializedRef.current = false;
      statusSnapshotRef.current = new Map();
      permissionWarningRef.current = null;
      return;
    }

    if (!Object.values(getRuntimeSettings().notificationPreferences).includes("system")) return;

    void browserRuntime.requestSystemNotificationPermission().then((permission) => {
      if (permission !== "denied" && permission !== "unsupported") return;
      if (permissionWarningRef.current === permission) return;

      permissionWarningRef.current = permission === "denied" ? "permission-denied" : permission;
      toast.info(
        permission === "denied" ? "系统通知未开启" : "当前环境不支持系统通知",
        permission === "denied" ? "实例成功或失败时将只显示应用内提示。" : undefined,
      );
    });
  }, [auth.token, toast]);

  useEffect(() => {
    const tasks = query.data?.items;
    if (!tasks) return;

    const previousSnapshot = statusSnapshotRef.current;
    const nextSnapshot = new Map(previousSnapshot);
    const shouldNotify = initializedRef.current;

    for (const task of tasks) {
      const taskId = getTaskNotificationId(task);
      const previousStatus = shouldNotify ? previousSnapshot.get(taskId) : undefined;
      const notification = getImportantTaskStatusNotification(task, previousStatus);

      if (notification) {
        const mode = getRuntimeSettings().notificationPreferences[notification.event];
        if (mode === "app") {
          showInAppNotification(notification);
        } else if (mode === "system") {
          void browserRuntime
            .notifySystem({
              title: notification.title,
              body: notification.body,
              tag: notification.tag,
            })
            .then((result) => {
              if (result === "shown") return;
              if (result === "permission-denied" || result === "unsupported") {
                permissionWarningRef.current = result;
              }
              toast.info(
                result === "permission-denied" ? "系统通知未开启" : "系统通知不可用",
                "可在设置中改为应用内通知或关闭该事件通知。",
              );
            });
        }
      }

      nextSnapshot.set(taskId, task.status);
    }

    initializedRef.current = true;
    statusSnapshotRef.current = nextSnapshot;
  }, [query.data?.items, query.dataUpdatedAt, showInAppNotification, toast]);

  return null;
}
