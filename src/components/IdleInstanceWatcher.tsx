import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { evaluateIdleInstance, getIdleInstanceReminder, type IdleEvaluation, type IdleInstanceReminder } from "../lib/idle-instance-reminder";
import { useI18n } from "../lib/i18n";
import { browserRuntime } from "../lib/runtime";
import { taskSnapshotQueryOptions } from "../lib/task-snapshot-query";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";

const IDLE_CHECK_INTERVAL_MS = 60_000;

/** Backend task status for a running instance (see `taskStatusText` in format.ts). */
const RUNNING_STATUS = 2;

/**
 * Background watcher for idle running instances. Polls `monitor_index` per
 * running task at most once a minute and warns (app or system notification,
 * per the `task.idle` preference) when CPU and network stay below thresholds
 * for the configured window. Reminding is once per idle episode: an instance
 * that becomes active (or unknown) again re-arms the warning. It never takes
 * action on the instance.
 */
export function IdleInstanceWatcher() {
  const auth = useAuth();
  const toast = useToast();
  const { locale, text } = useI18n();
  const navigate = useNavigate();
  const idleStatesRef = useRef<Map<string, IdleEvaluation>>(new Map());
  const lastCheckAtRef = useRef(0);
  const checkingRef = useRef(false);

  const enabled = Boolean(auth.token) && getRuntimeSettings().notificationPreferences["task.idle"] !== "off";

  // Shares the snapshot cache with TaskNotificationWatcher; same query key.
  const query = useQuery({
    ...taskSnapshotQueryOptions(instanceApi),
    enabled,
    refetchInterval: IDLE_CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!auth.token) {
      idleStatesRef.current = new Map();
      lastCheckAtRef.current = 0;
    }
  }, [auth.token]);

  const showReminder = useCallback((reminder: IdleInstanceReminder) => {
    toast.notify({
      kind: "info",
      title: reminder.title,
      description: reminder.body,
      durationMs: 15_000,
      action: {
        label: text("查看监控", "View monitor"),
        onClick: () => navigate(`/tasks/${encodeURIComponent(reminder.routeId)}?tab=monitor`),
      },
    });
  }, [navigate, text, toast]);

  useEffect(() => {
    const tasks = query.data?.items;
    if (!tasks || !auth.token) return;
    const settings = getRuntimeSettings();
    const mode = settings.notificationPreferences["task.idle"];
    if (mode === "off") return;
    const now = Date.now();
    if (checkingRef.current || now - lastCheckAtRef.current < IDLE_CHECK_INTERVAL_MS) return;
    checkingRef.current = true;
    lastCheckAtRef.current = now;

    const windowMs = settings.idleReminderWindowMs;
    const running = tasks.filter((task) => Number(task.status) === RUNNING_STATUS);
    const previousStates = idleStatesRef.current;
    const nextStates = new Map(previousStates);

    void (async () => {
      try {
        // Sequential on purpose: no parallel load against the lab console.
        for (const task of running) {
          try {
            const metrics = await instanceApi.monitorIndex({ task_id: String(task.task_id ?? task.id) });
            const evaluation = evaluateIdleInstance(metrics, Date.now(), windowMs);
            const key = String(task.id ?? task.task_id);
            // First sight of an idle instance warns too — finding a forgotten
            // instance right after launch is the main scenario.
            if (evaluation === "idle" && previousStates.get(key) !== "idle") {
              const reminder = getIdleInstanceReminder(task, locale);
              if (mode === "app") {
                showReminder(reminder);
              } else if (mode === "system") {
                void browserRuntime
                  .notifySystem({ title: reminder.title, body: reminder.body, tag: reminder.tag })
                  .then((result) => {
                    if (result !== "shown") showReminder(reminder);
                  });
              }
            }
            nextStates.set(key, evaluation);
          } catch (error) {
            console.warn("Failed to read monitor metrics for idle detection.", task.id, error);
          }
        }
        // Instances that stopped running reset, so a future run warns again.
        const runningKeys = new Set(running.map((task) => String(task.id ?? task.task_id)));
        for (const key of nextStates.keys()) {
          if (!runningKeys.has(key)) nextStates.delete(key);
        }
        idleStatesRef.current = nextStates;
      } finally {
        checkingRef.current = false;
      }
    })();
  }, [query.data?.items, query.dataUpdatedAt, auth.token, locale, showReminder]);

  return null;
}
