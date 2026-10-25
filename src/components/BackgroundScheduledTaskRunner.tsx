import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { appendHeldOwnerMismatchEntry } from "../lib/execution-ledger";
import { useI18n } from "../lib/i18n";
import { appendRunLog } from "../lib/run-logs";
import { browserRuntime } from "../lib/runtime";
import { executeScheduledTask } from "../lib/schedule-execution";
import {
  holdScheduledTaskForReview,
  isMissedScheduleRun,
  isScheduleDue,
  missedScheduleSkipNote,
  mutateScheduledTasks,
  resetStaleRunningTasks,
  scheduledTaskOwnerMismatch,
  skipMissedScheduledRun,
  sortScheduledTasks,
  updateScheduledTask,
} from "../lib/scheduled-tasks";
import { maybeAllocateUniqueCreateTaskNames } from "../lib/task-name-unique";
import { invalidateTaskQueries } from "../lib/task-snapshot-query";
import type { ScheduledTask } from "../lib/types";
import { errorMessage } from "../lib/use-run-logger";
import { EXECUTION_LEDGER_ROUTE } from "../lib/use-execution-review";
import { useToast } from "../lib/use-toast";

const CHECK_INTERVAL_MS = 30_000;
const BACKGROUND_LOCK_NAME = "easy-console.background-scheduled-task-runner";

type RuntimeLockManager = {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
};

function startDesktopBackgroundLock() {
  if (!browserRuntime.isDesktop || typeof navigator === "undefined") return () => undefined;

  const locks = (navigator as Navigator & { locks?: RuntimeLockManager }).locks;
  if (!locks) return () => undefined;

  const controller = new AbortController();
  const waitUntilStopped = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  void locks
    .request(BACKGROUND_LOCK_NAME, { mode: "shared", signal: controller.signal }, () => waitUntilStopped)
    .catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("Failed to hold EasyConsole background lock.", error);
    });

  return () => controller.abort();
}

export function BackgroundScheduledTaskRunner() {
  const toast = useToast();
  const { text } = useI18n();
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  // Missed-run "ask" notifications are deduped per schedule slot (`id@scheduleTime`)
  // so the 30-second loop does not re-toast an undecided row. Ref, not state:
  // it survives effect restarts and never re-renders the runner.
  const askedMissedKeysRef = useRef<Set<string>>(new Set());

  // `text` from useI18n is recreated whenever the locale changes. The scheduling
  // effect below owns the interval, the wake-up listeners and the desktop
  // background lock, so depending on `text` directly meant every language switch
  // tore the runner down and restarted it. Route translation through a ref.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const tt = useCallback((zh: string, en: string) => textRef.current(zh, en), []);
  // Same reason: useNavigate changes with the location, which must not restart the runner.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const reviewAction = useCallback(
    (label: string, to: string = EXECUTION_LEDGER_ROUTE) => ({ label, onClick: () => navigateRef.current(to) }),
    [],
  );

  useEffect(() => {
    let disposed = false;

    async function persistUpdate(updater: (items: ScheduledTask[]) => ScheduledTask[]) {
      return mutateScheduledTasks(browserRuntime.storage, (current) => sortScheduledTasks(updater(current)));
    }

    async function executeDueTasks() {
      if (disposed || runningRef.current) return;
      runningRef.current = true;
      try {
        const settings = getRuntimeSettings();
        const items = await persistUpdate((current) => resetStaleRunningTasks(current));
        const due = items.filter((item) => isScheduleDue(item));
        for (const task of due) {
          if (disposed) return;
          // Never submit a remote create under an account that does not own the
          // schedule. Mismatched or legacy-owner rows are held for the user to
          // pick the original account or migrate the task. Re-check against the
          // latest row inside the storage lock: another window may have edited
          // or adopted (resumed) the task since this list was loaded.
          const mismatch = scheduledTaskOwnerMismatch(task);
          if (mismatch) {
            const hold = { outcome: "gone" as "held" | "runnable" | "gone", reason: mismatch.reason };
            await persistUpdate((current) => {
              const latest = current.find((item) => item.id === task.id);
              if (!latest) return current;
              const latestMismatch = scheduledTaskOwnerMismatch(latest);
              if (!latestMismatch) {
                hold.outcome = "runnable"; // adopted/resolved from another window
                return current;
              }
              hold.outcome = "held";
              hold.reason = latestMismatch.reason;
              return updateScheduledTask(current, holdScheduledTaskForReview(latest, latestMismatch.reason));
            });
            if (hold.outcome === "held") {
              toast.error(
                tt("定时任务待用户处理", "Scheduled task held for review"),
                `${task.name}: ${hold.reason}`,
                reviewAction(tt("去处理", "Resolve"), "/scheduled-tasks"),
              );
              void appendRunLog(browserRuntime.storage, {
                source: "scheduled-task",
                level: "warning",
                channel: browserRuntime.runLogChannel,
                action: "scheduledTask.ownerMismatch",
                result: "failure",
                title: tt("定时任务待用户处理", "Scheduled task held for review"),
                targetName: task.name,
                targetId: task.id,
                error: hold.reason,
              });
              // Execution-ledger audit entry for the hold. Best-effort: the
              // helper swallows write failures so the runner loop is unaffected.
              void appendHeldOwnerMismatchEntry(browserRuntime.storage, task, hold.reason);
              continue;
            }
            if (hold.outcome === "gone") continue;
            // runnable: another window adopted the task; execute it now.
          }
          // A run that became due while the app was closed or asleep was
          // "missed": creating the instance now is late, possibly hours late,
          // so follow the user's policy instead of blindly catching up.
          if (
            settings.missedSchedulePolicy !== "run" &&
            isMissedScheduleRun(task, new Date(), settings.missedScheduleGraceMs)
          ) {
            if (settings.missedSchedulePolicy === "skip") {
              let skipped = false;
              await persistUpdate((current) => {
                const latest = current.find((item) => item.id === task.id);
                // Re-check inside the storage lock: another window may have run,
                // edited, or rescheduled this row since the list was loaded.
                if (!latest || !isMissedScheduleRun(latest, new Date(), settings.missedScheduleGraceMs)) return current;
                skipped = true;
                return updateScheduledTask(current, skipMissedScheduledRun(latest, missedScheduleSkipNote(latest)));
              });
              if (skipped) {
                toast.info(tt("已跳过错过的定时任务", "Missed scheduled task skipped"), task.name);
                void appendRunLog(browserRuntime.storage, {
                  source: "scheduled-task",
                  level: "warning",
                  channel: browserRuntime.runLogChannel,
                  action: "scheduledTask.missedSkip",
                  result: "failure",
                  title: tt("已跳过错过的定时任务", "Missed scheduled task skipped"),
                  targetName: task.name,
                  targetId: task.id,
                  metadata: { scheduleTime: task.scheduleTime },
                });
              }
              continue;
            }
            // "ask": the row stays pending for the user to run or skip from the
            // scheduled tasks page. It is deliberately NOT held as needs_review
            // or paused — resuming such a row would re-trip this check and loop.
            // The ask is deduped per schedule slot for this app session.
            const askKey = `${task.id}@${task.scheduleTime}`;
            if (!askedMissedKeysRef.current.has(askKey)) {
              askedMissedKeysRef.current.add(askKey);
              const scheduledFor = task.scheduleTime.replace("T", " ").slice(0, 16);
              const reason = tt(
                `计划已错过（原定 ${scheduledFor}），等待确认后再执行。`,
                `Missed its scheduled time (${scheduledFor}); waiting for your confirmation before running.`,
              );
              toast.error(
                tt("定时任务已错过，待确认", "Scheduled task missed, awaiting confirmation"),
                `${task.name}: ${reason}`,
                reviewAction(tt("去处理", "Resolve"), "/scheduled-tasks"),
              );
              void appendRunLog(browserRuntime.storage, {
                source: "scheduled-task",
                level: "warning",
                channel: browserRuntime.runLogChannel,
                action: "scheduledTask.missedAsk",
                result: "failure",
                title: tt("定时任务已错过，待确认", "Scheduled task missed, awaiting confirmation"),
                targetName: task.name,
                targetId: task.id,
                error: reason,
                metadata: { scheduleTime: task.scheduleTime },
              });
            }
            continue;
          }
          try {
            const result = await executeScheduledTask(browserRuntime.storage, task.id, {
              createTask: (payload) => instanceApi.createTask(payload),
              preparePayload: async (payload) => {
                const [next] = await maybeAllocateUniqueCreateTaskNames([payload], {
                  enabled: getRuntimeSettings().autoNumberDuplicateTaskNames,
                  checkTaskName: (name) => instanceApi.checkTaskName(name),
                });
                return next!;
              },
            });
            if (result.skipped) continue;
            invalidateTaskQueries(queryClient);
            if (result.outcome === "local-persist-failed") {
              // The remote task exists but could not be recorded locally. Never
              // re-create it; surface the held state for manual verification.
              toast.error(
                tt("定时任务已创建但待核对", "Scheduled task created but needs review"),
                `${task.name}: ${result.task.lastError ?? ""}`,
                reviewAction(tt("去核对", "Review")),
              );
              void appendRunLog(browserRuntime.storage, {
                source: "scheduled-task",
                level: "warning",
                channel: browserRuntime.runLogChannel,
                action: "scheduledTask.execute",
                result: "failure",
                title: tt("定时任务已创建但待核对", "Scheduled task created but needs review"),
                targetName: task.name,
                targetId: task.id,
                error: result.task.lastError ?? tt("本地保存失败", "Local save failed"),
                metadata: { remoteTaskId: result.remoteTaskId },
              });
              continue;
            }
            toast.success(tt("定时任务已执行", "Scheduled task executed"), task.name);
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "info",
              channel: browserRuntime.runLogChannel,
              action: "scheduledTask.execute",
              result: "success",
              title: tt("定时任务已执行", "Scheduled task executed"),
              targetName: task.name,
              targetId: task.id,
              metadata: { remoteTaskId: result.remoteTaskId },
            });
          } catch (error) {
            // A network-level failure is recorded as "unknown" and may have created the instance anyway.
            toast.error(
              tt("定时任务执行失败", "Scheduled task execution failed"),
              `${task.name}: ${error instanceof Error ? error.message : tt("请稍后重试", "Try again later")}`,
              reviewAction(tt("查看台账", "Open ledger")),
            );
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "error",
              channel: browserRuntime.runLogChannel,
              action: "scheduledTask.execute",
              result: "failure",
              title: tt("定时任务执行失败", "Scheduled task execution failed"),
              targetName: task.name,
              targetId: task.id,
              error: errorMessage(error, tt("定时任务执行失败", "Scheduled task execution failed")),
            });
          }
        }
      } finally {
        runningRef.current = false;
      }
    }

    const stopBackgroundLock = startDesktopBackgroundLock();
    const runDue = () => void executeDueTasks();
    let removeDesktopRunDue: (() => void) | null = null;

    void executeDueTasks();
    const timer = window.setInterval(() => void executeDueTasks(), CHECK_INTERVAL_MS);
    window.addEventListener("focus", runDue);
    window.addEventListener("online", runDue);
    window.addEventListener("pageshow", runDue);
    document.addEventListener("visibilitychange", runDue);
    void browserRuntime.onDesktopRunDueScheduledTasks(runDue).then((remove) => {
      if (disposed) {
        remove();
        return;
      }
      removeDesktopRunDue = remove;
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", runDue);
      window.removeEventListener("online", runDue);
      window.removeEventListener("pageshow", runDue);
      document.removeEventListener("visibilitychange", runDue);
      stopBackgroundLock();
      removeDesktopRunDue?.();
    };
  }, [queryClient, reviewAction, tt, toast]);

  return null;
}
