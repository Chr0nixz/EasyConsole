import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { instanceApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { appendRunLog } from "../lib/run-logs";
import { browserRuntime } from "../lib/runtime";
import { isScheduleDue, mutateScheduledTasks, resetStaleRunningTasks, scheduleNextRun, sortScheduledTasks, updateScheduledTask } from "../lib/scheduled-tasks";
import { invalidateTaskQueries } from "../lib/task-snapshot-query";
import type { ScheduledTask } from "../lib/types";
import { errorMessage } from "../lib/use-run-logger";
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

  useEffect(() => {
    let disposed = false;

    async function persistUpdate(updater: (items: ScheduledTask[]) => ScheduledTask[]) {
      return mutateScheduledTasks(browserRuntime.storage, (current) => sortScheduledTasks(updater(current)));
    }

    async function executeDueTasks() {
      if (disposed || runningRef.current) return;
      runningRef.current = true;
      try {
        // Reset tasks stuck in "running" (e.g. from a previous crash) before evaluating.
        const items = await persistUpdate((current) => resetStaleRunningTasks(current));
        const due = items.filter((item) => isScheduleDue(item));
        for (const task of due) {
          if (disposed) return;
          await persistUpdate((current) => updateScheduledTask(current, { ...task, status: "running", lastError: undefined }));
          try {
            await instanceApi.createTask(task.payload);
            const completedTask: ScheduledTask = { ...task, status: "done", lastRunAt: new Date().toISOString(), lastError: undefined };
            const nextTask = scheduleNextRun(completedTask);
            await persistUpdate((current) => updateScheduledTask(current, nextTask ?? completedTask));
            invalidateTaskQueries(queryClient);
            toast.success(text("定时任务已执行", "Scheduled task executed"), task.name);
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "info",
              channel: browserRuntime.runLogChannel,
              action: "scheduledTask.execute",
              result: "success",
              title: text("定时任务已执行", "Scheduled task executed"),
              targetName: task.name,
              targetId: task.id,
            });
          } catch (error) {
            await persistUpdate((current) => updateScheduledTask(current, {
              ...task,
              status: "failed",
              lastRunAt: new Date().toISOString(),
              lastError: error instanceof Error ? error.message : text("执行失败", "Execution failed"),
            }));
            toast.error(text("定时任务执行失败", "Scheduled task execution failed"), `${task.name}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "error",
              channel: browserRuntime.runLogChannel,
              action: "scheduledTask.execute",
              result: "failure",
              title: text("定时任务执行失败", "Scheduled task execution failed"),
              targetName: task.name,
              targetId: task.id,
              error: errorMessage(error, text("定时任务执行失败", "Scheduled task execution failed")),
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
  }, [queryClient, text, toast]);

  return null;
}
