import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { apiClient, instanceApi } from "../lib/api";
import { getActiveAccountScope, normalizeApiRealm } from "../lib/account-scope";
import { getRuntimeSettings, subscribeRuntimeSettings } from "../lib/app-settings";
import { evaluateIdleInstance, getIdleInstanceReminder, hasFreshIdleMetrics, type IdleInstanceReminder } from "../lib/idle-instance-reminder";
import { clearIdleInstances, publishIdleInstances, type IdleEvidence } from "../lib/idle-instance-state";
import { sampleGpuIdle, type GpuIdleHistory } from "../lib/idle-gpu";
import { releaseIdleInstance } from "../lib/idle-auto-release";
import { appendRunLog } from "../lib/run-logs";
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
 * that becomes active (or unknown) again re-arms the warning. Auto-release is
 * opt-in and requires a continuous full window of real GPU samples.
 */
export function IdleInstanceWatcher() {
  const auth = useAuth();
  const toast = useToast();
  const { locale, text } = useI18n();
  const navigate = useNavigate();
  const idleStatesRef = useRef<Map<string, string>>(new Map());
  const gpuHistoryRef = useRef<Map<string, GpuIdleHistory>>(new Map());
  const lastCheckAtRef = useRef(0);
  const checkingRef = useRef(false);
  const settings = useSyncExternalStore(subscribeRuntimeSettings, getRuntimeSettings, getRuntimeSettings);
  const accountScope = getActiveAccountScope().key;

  const enabled = Boolean(auth.token) && (settings.notificationPreferences["task.idle"] !== "off" || settings.idleAutoRelease);

  // Shares the snapshot cache with TaskNotificationWatcher; same query key.
  const query = useQuery({
    ...taskSnapshotQueryOptions(instanceApi),
    enabled,
    refetchInterval: IDLE_CHECK_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    idleStatesRef.current = new Map();
    gpuHistoryRef.current = new Map();
    lastCheckAtRef.current = 0;
  }, [accountScope]);

  // Idle marks belong to this account and this preference; switching either drops them.
  useEffect(() => {
    if (!enabled) return;
    return () => clearIdleInstances();
  }, [enabled, accountScope]);

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
    const mode = settings.notificationPreferences["task.idle"];
    if (mode === "off" && !settings.idleAutoRelease) return;
    const now = Date.now();
    if (checkingRef.current || now - lastCheckAtRef.current < IDLE_CHECK_INTERVAL_MS) return;
    checkingRef.current = true;
    lastCheckAtRef.current = now;

    const windowMs = settings.idleReminderWindowMs;
    const running = tasks.filter((task) => Number(task.status) === RUNNING_STATUS);
    const previousStates = idleStatesRef.current;
    const nextStates = new Map(previousStates);
    let disposed = false;
    const scope = getActiveAccountScope().key;
    const baseUrl = apiClient.getBaseUrl();
    const isCurrent = () => !disposed && apiClient.getToken() === auth.token && apiClient.getBaseUrl() === baseUrl && getActiveAccountScope().key === scope;

    void (async () => {
      try {
        // Sequential on purpose: no parallel load against the lab console.
        for (const task of running) {
          if (!isCurrent()) return;
          try {
            const metrics = await instanceApi.monitorIndex({ task_id: String(task.task_id ?? task.id) });
            if (!isCurrent()) return;
            const key = String(task.id ?? task.task_id);
            const gpu = await browserRuntime.readTaskGpuUtilization(String(task.task_id ?? task.id)).catch(() => null);
            if (!isCurrent()) return;
            const probe = sampleGpuIdle(gpuHistoryRef.current.get(key), gpu, Date.now(), windowMs);
            if (probe.history) gpuHistoryRef.current.set(key, probe.history);
            else gpuHistoryRef.current.delete(key);
            const evaluation = probe.evaluation === "active" ? "active" : evaluateIdleInstance(metrics, Date.now(), windowMs);
            const verifiedGpu = probe.evaluation === "idle";
            const state = evaluation === "idle" ? `idle:${verifiedGpu ? "gpu" : "heuristic"}` : evaluation;
            // First sight of an idle instance warns too — finding a forgotten
            // instance right after launch is the main scenario.
            if (evaluation === "idle" && previousStates.get(key) !== state) {
              const reminder = getIdleInstanceReminder(task, locale, verifiedGpu);
              if (mode === "app") {
                showReminder(reminder);
              } else if (mode === "system") {
                void browserRuntime
                  .notifySystem({ title: reminder.title, body: reminder.body, tag: reminder.tag })
                  .then((result) => { if (isCurrent() && result !== "shown") showReminder(reminder); })
                  .catch(() => { if (isCurrent()) showReminder(reminder); });
              }
            }
            const allAllocatedGpus = Number.isInteger(task.gpu) && Number(task.gpu) > 0 && gpu?.length === Number(task.gpu);
            const sameRealm = scope.endsWith(`@${normalizeApiRealm(baseUrl)}`);
            if (evaluation === "idle" && verifiedGpu && allAllocatedGpus && sameRealm && hasFreshIdleMetrics(metrics, Date.now(), windowMs) && settings.idleAutoRelease && browserRuntime.isDesktop) {
              try {
                const result = await releaseIdleInstance({
                  storage: browserRuntime.storage, task, accountScope: scope,
                  isCurrent: () => isCurrent() && getRuntimeSettings().idleAutoRelease,
                  release: () => instanceApi.operateTask(task.id),
                });
                if (result === "released" && isCurrent()) {
                  toast.success(text("闲置实例已释放", "Idle instance released"), String(task.name ?? task.id));
                  void appendRunLog(browserRuntime.storage, {
                    channel: browserRuntime.runLogChannel, source: "task", level: "info", action: "task.idleRelease", result: "success",
                    title: text("闲置实例已释放", "Idle instance released"), targetId: task.id, metadata: { accountScope: scope },
                  }).catch(() => undefined);
                }
              } catch (error) {
                if (isCurrent()) toast.error(text("自动释放未确认，请手动核对", "Auto-release unconfirmed; review manually"), error instanceof Error ? error.message : String(error));
                void appendRunLog(browserRuntime.storage, {
                  channel: browserRuntime.runLogChannel, source: "task", level: "warning", action: "task.idleRelease", result: "failure",
                  title: text("自动释放未确认，请手动核对", "Auto-release unconfirmed; review manually"), targetId: task.id,
                  error: error instanceof Error ? error.message : String(error), metadata: { accountScope: scope },
                }).catch(() => undefined);
              }
            }
            nextStates.set(key, state);
          } catch (error) {
            // A previous low reading is no longer evidence when monitoring fails.
            const key = String(task.id ?? task.task_id);
            nextStates.delete(key);
            gpuHistoryRef.current.delete(key);
            console.warn("Failed to read monitor metrics for idle detection.", task.id, error);
          }
        }
        // Instances that stopped running reset, so a future run warns again.
        const runningKeys = new Set(running.map((task) => String(task.id ?? task.task_id)));
        for (const key of nextStates.keys()) {
          if (!runningKeys.has(key)) { nextStates.delete(key); gpuHistoryRef.current.delete(key); }
        }
        if (isCurrent()) {
          idleStatesRef.current = nextStates;
          const idle = new Map<string, IdleEvidence>();
          for (const [key, state] of nextStates) {
            if (state.startsWith("idle:")) idle.set(key, state === "idle:gpu" ? "gpu" : "heuristic");
          }
          publishIdleInstances(idle);
        }
      } finally {
        checkingRef.current = false;
      }
    })();
    return () => { disposed = true; };
  }, [query.data?.items, query.dataUpdatedAt, auth.token, accountScope, locale, showReminder, text, toast, settings]);

  return null;
}
