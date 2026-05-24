import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { instanceApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { appendRunLog } from "../lib/run-logs";
import { browserRuntime } from "../lib/runtime";
import { isScheduleDue, loadScheduledTasks, saveScheduledTasks, sortScheduledTasks, updateScheduledTask } from "../lib/scheduled-tasks";
import type { ScheduledTask } from "../lib/types";
import { errorMessage } from "../lib/use-run-logger";
import { useToast } from "../lib/use-toast";

const CHECK_INTERVAL_MS = 30_000;

export function BackgroundScheduledTaskRunner() {
  const toast = useToast();
  const { text } = useI18n();
  const queryClient = useQueryClient();
  const runningRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    async function persist(items: ScheduledTask[]) {
      const sorted = sortScheduledTasks(items);
      await saveScheduledTasks(browserRuntime.storage, sorted);
      return sorted;
    }

    async function executeDueTasks() {
      if (disposed || runningRef.current) return;
      runningRef.current = true;
      try {
        let items = sortScheduledTasks(await loadScheduledTasks(browserRuntime.storage));
        const due = items.filter((item) => isScheduleDue(item));
        for (const task of due) {
          if (disposed) return;
          items = await persist(updateScheduledTask(items, { ...task, status: "running", lastError: undefined }));
          try {
            await instanceApi.createTask(task.payload);
            items = await persist(updateScheduledTask(items, { ...task, status: "done", lastRunAt: new Date().toISOString(), lastError: undefined }));
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
            toast.success(text("定时任务已执行", "Scheduled task executed"), task.name);
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "info",
              channel: browserRuntime.isDesktop ? "tauri" : "web",
              action: "scheduledTask.execute",
              result: "success",
              title: text("定时任务已执行", "Scheduled task executed"),
              targetName: task.name,
              targetId: task.id,
            });
          } catch (error) {
            items = await persist(updateScheduledTask(items, {
              ...task,
              status: "failed",
              lastRunAt: new Date().toISOString(),
              lastError: error instanceof Error ? error.message : text("执行失败", "Execution failed"),
            }));
            toast.error(text("定时任务执行失败", "Scheduled task execution failed"), `${task.name}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`);
            void appendRunLog(browserRuntime.storage, {
              source: "scheduled-task",
              level: "error",
              channel: browserRuntime.isDesktop ? "tauri" : "web",
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

    void executeDueTasks();
    const timer = window.setInterval(() => void executeDueTasks(), CHECK_INTERVAL_MS);
    void browserRuntime.onDesktopRunDueScheduledTasks(() => void executeDueTasks()).then((remove) => {
      if (disposed) remove();
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [queryClient, text, toast]);

  return null;
}
