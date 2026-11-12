import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { instanceApi } from "./api";
import { formatCost, getTaskName } from "./format";
import { useI18n } from "./i18n";
import {
  formatReleaseMoment,
  formatReleaseTimeInput,
  getExtendedReleaseAt,
  getExtensionCost,
} from "./task-release-notifications";
import { invalidateTaskQueries } from "./task-snapshot-query";
import type { Task } from "./types";
import { errorMessage, useRunLogger } from "./use-run-logger";
import { useToast } from "./use-toast";

type ExtendInput = { task: Task; hours: number };

/**
 * Extends a timed release by writing a new `releace_time` through the edit endpoint. No
 * verified backend extension API exists (the original console has none), so an unsupported
 * backend surfaces updateTask's clear "not supported" error. One path for the detail page,
 * the task list and the reminder toast, so each logs and reports the same way.
 */
export function useExtendRelease() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const runLogger = useRunLogger();
  const { locale, text } = useI18n();

  const mutation = useMutation({
    mutationFn: async ({ task, hours }: ExtendInput) => {
      const releaseAt = getExtendedReleaseAt(task, hours, Date.now());
      const releaceTime = formatReleaseTimeInput(new Date(releaseAt));
      await instanceApi.updateTask(task.id, { releace_time: releaceTime });
      return { releaseAt, releaceTime };
    },
    onSuccess: ({ releaseAt, releaceTime }, { task, hours }) => {
      const cost = getExtensionCost(task, hours);
      const when = formatReleaseMoment(releaseAt, locale);
      toast.success(
        text("释放时间已延长", "Release time extended"),
        cost === null
          ? text(`${getTaskName(task)}：新释放时间 ${when}`, `${getTaskName(task)}: now releases at ${when}`)
          : text(
              `${getTaskName(task)}：新释放时间 ${when}，按单价约多计费 ${formatCost(cost, locale)}`,
              `${getTaskName(task)}: now releases at ${when}, about ${formatCost(cost, locale)} more at its rate`,
            ),
      );
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.extendRelease",
        result: "success",
        title: text("释放时间已延长", "Release time extended"),
        targetName: getTaskName(task),
        targetId: task.id,
        metadata: { releaceTime, hours },
      });
      invalidateTaskQueries(queryClient);
    },
    onError: (error, { task }) => {
      toast.error(
        text("延长释放失败", "Failed to extend release"),
        `${getTaskName(task)}: ${error instanceof Error ? error.message : text("请稍后重试", "Try again later")}`,
      );
      void runLogger.log({
        source: "task",
        level: "error",
        action: "task.extendRelease",
        result: "failure",
        title: text("延长释放失败", "Failed to extend release"),
        targetName: getTaskName(task),
        targetId: task.id,
        error: errorMessage(error, text("延长释放失败", "Failed to extend release")),
      });
    },
  });

  const { mutate } = mutation;
  const extend = useCallback(
    (task: Task, hours: number, options?: { onSuccess?: () => void }) =>
      mutate({ task, hours }, { onSuccess: () => options?.onSuccess?.() }),
    [mutate],
  );

  return { extend, pending: mutation.isPending };
}
