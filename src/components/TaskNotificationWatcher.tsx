import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
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
      return;
    }
  }, [auth.token]);

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
              if (result !== "shown") showInAppNotification(notification);
            });
        }
      }

      nextSnapshot.set(taskId, task.status);
    }

    initializedRef.current = true;
    statusSnapshotRef.current = nextSnapshot;
  }, [query.data?.items, query.dataUpdatedAt, showInAppNotification]);

  return null;
}
