import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { i18nText } from "../lib/i18n-text";
import { browserRuntime } from "../lib/runtime";
import { getImportantTaskStatusNotification, getTaskNotificationId, type ImportantTaskStatusNotification } from "../lib/task-status-notifications";
import {
  nextNotificationPollInterval,
  TASK_SNAPSHOT_POLL_INTERVAL,
  taskSnapshotQueryOptions,
} from "../lib/task-snapshot-query";
import type { TaskStatus } from "../lib/types";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";

export function TaskNotificationWatcher() {
  const auth = useAuth();
  const toast = useToast();
  const initializedRef = useRef(false);
  const statusSnapshotRef = useRef<Map<string, TaskStatus | undefined>>(new Map());
  const permissionWarningRef = useRef<"permission-denied" | "unsupported" | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const [pollInterval, setPollInterval] = useState(TASK_SNAPSHOT_POLL_INTERVAL);

  const onTasksPage = Boolean(useMatch("/tasks"));

  useEffect(() => {
    const onVisibility = () => {
      const nextHidden = document.visibilityState === "hidden";
      setHidden(nextHidden);
      setPollInterval((current) => (nextHidden ? nextNotificationPollInterval(current, true) : TASK_SNAPSHOT_POLL_INTERVAL));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const query = useQuery({
    ...taskSnapshotQueryOptions(instanceApi),
    enabled: Boolean(auth.token),
    refetchInterval: onTasksPage ? false : pollInterval,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (onTasksPage || !query.isFetched) return;
    if (hidden) {
      setPollInterval((current) => nextNotificationPollInterval(current, true));
    }
  }, [hidden, onTasksPage, query.dataUpdatedAt, query.isFetched]);

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
        permission === "denied"
          ? i18nText("系统通知未开启", "System notifications are disabled")
          : i18nText("当前环境不支持系统通知", "System notifications are not supported in this environment"),
        permission === "denied"
          ? i18nText("实例成功或失败时将只显示应用内提示。", "In-app toasts will be shown for instance success or failure.")
          : undefined,
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
                result === "permission-denied"
                  ? i18nText("系统通知未开启", "System notifications are disabled")
                  : i18nText("系统通知不可用", "System notifications are unavailable"),
                i18nText("可在设置中改为应用内通知或关闭该事件通知。", "Switch to in-app notifications or disable this event in Settings."),
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
