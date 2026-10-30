import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { recordUnseenTaskFailure } from "../lib/task-attention";
import { getUpcomingTimedReleaseNotification, type TimedReleaseDueNotification } from "../lib/task-release-notifications";
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
  const { locale, text } = useI18n();
  const navigate = useNavigate();
  const initializedRef = useRef(false);
  const statusSnapshotRef = useRef<Map<string, TaskStatus | undefined>>(new Map());
  // Session-scoped: a timed release warns once per release time; extending the
  // task changes the key and re-arms the reminder.
  const warnedReleaseKeysRef = useRef<Set<string>>(new Set());
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
    if (notification.kind !== "failure") {
      toast.success(notification.title, notification.body);
      return;
    }
    // A failure is only useful if it leads somewhere: the toast opens the task's log,
    // and stays long enough to be acted on (hover or focus still pauses it).
    toast.notify({
      kind: "error",
      title: notification.title,
      description: notification.body,
      durationMs: 15_000,
      action: {
        label: text("查看日志", "View logs"),
        onClick: () => navigate(`/tasks/${encodeURIComponent(notification.routeId)}?tab=log`),
      },
    });
  }, [navigate, text, toast]);

  const showInAppReleaseNotification = useCallback((notification: TimedReleaseDueNotification) => {
    toast.notify({
      kind: "info",
      title: notification.title,
      description: notification.body,
      durationMs: 15_000,
      action: {
        label: text("去处理", "Resolve"),
        onClick: () => navigate(`/tasks/${encodeURIComponent(notification.routeId)}`),
      },
    });
  }, [navigate, text, toast]);

  useEffect(() => {
    if (!auth.token) {
      initializedRef.current = false;
      statusSnapshotRef.current = new Map();
      warnedReleaseKeysRef.current = new Set();
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
      const notification = getImportantTaskStatusNotification(task, previousStatus, locale);

      if (notification) {
        if (notification.kind === "failure") recordUnseenTaskFailure(notification.routeId);
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

      // A timed release firing within the lead window warns once per release
      // time. Unlike status changes it re-evaluates on every snapshot so an
      // extension (new releace_time) can re-arm the reminder.
      const settings = getRuntimeSettings();
      const dueNotification = getUpcomingTimedReleaseNotification(
        task,
        Date.now(),
        settings.timedReleaseReminderLeadMs,
        locale,
      );
      if (dueNotification && !warnedReleaseKeysRef.current.has(dueNotification.dedupeKey)) {
        warnedReleaseKeysRef.current.add(dueNotification.dedupeKey);
        const mode = settings.notificationPreferences[dueNotification.event];
        if (mode === "app") {
          showInAppReleaseNotification(dueNotification);
        } else if (mode === "system") {
          void browserRuntime
            .notifySystem({
              title: dueNotification.title,
              body: dueNotification.body,
              tag: dueNotification.tag,
            })
            .then((result) => {
              if (result !== "shown") showInAppReleaseNotification(dueNotification);
            });
        }
      }
    }

    initializedRef.current = true;
    statusSnapshotRef.current = nextSnapshot;
  }, [query.data?.items, query.dataUpdatedAt, showInAppNotification, showInAppReleaseNotification, locale]);

  return null;
}
