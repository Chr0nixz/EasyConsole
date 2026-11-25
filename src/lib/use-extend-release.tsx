import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { instanceApi } from "./api";
import { isOutcomeUnknown } from "./api-client";
import { extendTimedRelease, ExtendReleaseRefusedError } from "./extend-release";
import { formatCost, getTaskName } from "./format";
import { useI18n } from "./i18n";
import { formatReleaseMoment, getExtensionCost } from "./task-release-notifications";
import { invalidateTaskQueries, taskSnapshotQueryOptions } from "./task-snapshot-query";
import type { Task } from "./types";
import { errorMessage, useRunLogger } from "./use-run-logger";
import { useToast } from "./use-toast";

type ExtendInput = { task: Task; hours: number };

/**
 * Extends a timed release by writing a new `releace_time` through the edit endpoint. No
 * verified backend extension API exists (the original console has none), so an unsupported
 * backend surfaces updateTask's clear "not supported" error. One path for the detail page,
 * the task list and the reminder toast, so each logs and reports the same way.
 *
 * The new time is computed from a fresh read of the shared task snapshot, and read back
 * afterwards; see `extendTimedRelease`.
 */
export function useExtendRelease() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const runLogger = useRunLogger();
  const { locale, text } = useI18n();

  const mutation = useMutation({
    mutationFn: ({ task, hours }: ExtendInput) =>
      extendTimedRelease(task, hours, {
        // staleTime 0 forces a request and refreshes the snapshot every view reads, so a
        // refused extension leaves the dialog showing the backend's current release time.
        loadTasks: async () => (await queryClient.fetchQuery({ ...taskSnapshotQueryOptions(instanceApi), staleTime: 0 })).items,
        updateTask: (id, payload) => instanceApi.updateTask(id, payload),
      }),
    onSuccess: ({ releaseAt, releaceTime, verification, backendReleaseAt }, { task, hours }) => {
      const name = getTaskName(task);
      const when = formatReleaseMoment(releaseAt, locale);
      if (verification === "mismatch") {
        const actual = backendReleaseAt === null ? text("未知", "unknown") : formatReleaseMoment(backendReleaseAt, locale);
        const title = text("释放时间没有按预期更新", "Release time did not update as expected");
        toast.notify({
          kind: "warning",
          title,
          description: text(
            `${name}：已提交 ${when}，后端现在的释放时间是 ${actual}。请在实例详情里核对。`,
            `${name}: ${when} was submitted, but the backend now shows ${actual}. Check the instance details.`,
          ),
          durationMs: 15_000,
        });
        void runLogger.log({
          source: "task",
          level: "warning",
          action: "task.extendRelease",
          result: "failure",
          title,
          targetName: name,
          targetId: task.id,
          metadata: { releaceTime, hours, verification },
        });
        invalidateTaskQueries(queryClient);
        return;
      }
      const cost = getExtensionCost(task, hours);
      const unchecked = verification === "unchecked"
        ? text("；未能读回后端的释放时间，请稍后核对", "; the backend's release time could not be read back, check it later")
        : "";
      toast.success(
        text("释放时间已延长", "Release time extended"),
        cost === null
          ? text(`${name}：新释放时间 ${when}${unchecked}`, `${name}: now releases at ${when}${unchecked}`)
          : text(
              `${name}：新释放时间 ${when}，按单价约多计费 ${formatCost(cost, locale)}${unchecked}`,
              `${name}: now releases at ${when}, about ${formatCost(cost, locale)} more at its rate${unchecked}`,
            ),
      );
      void runLogger.log({
        source: "task",
        level: "info",
        action: "task.extendRelease",
        result: "success",
        title: text("释放时间已延长", "Release time extended"),
        targetName: name,
        targetId: task.id,
        metadata: { releaceTime, hours, verification },
      });
      invalidateTaskQueries(queryClient);
    },
    onError: (error, { task }) => {
      const name = getTaskName(task);
      if (error instanceof ExtendReleaseRefusedError) {
        const title = text("未延长释放时间", "Release time not extended");
        const latest = error.latestReleaseAt === null ? null : formatReleaseMoment(error.latestReleaseAt, locale);
        const reason =
          error.reason === "changed"
            ? latest === null
              ? text("释放时间已在别处修改，请确认后再延长。", "The release time was changed elsewhere. Review it before extending.")
              : text(`释放时间已在别处改为 ${latest}，请确认后再延长。`, `The release time was changed elsewhere to ${latest}. Review it before extending.`)
            : error.reason === "not-extendable"
              ? text("实例已不是运行中的定时释放实例。", "The instance is no longer a live timed-release instance.")
              : text("没有找到这个实例的最新状态，请刷新后再试。", "The instance's current state could not be found. Refresh and try again.");
        toast.notify({ kind: "warning", title, description: text(`${name}：${reason}`, `${name}: ${reason}`) });
        void runLogger.log({
          source: "task",
          level: "warning",
          action: "task.extendRelease",
          result: "failure",
          title,
          targetName: name,
          targetId: task.id,
          error: reason,
          metadata: { refusal: error.reason },
        });
        invalidateTaskQueries(queryClient);
        return;
      }
      // A timeout, unreadable response or 5xx may still have written the new time.
      const unknown = isOutcomeUnknown(error);
      const title = unknown ? text("延长结果未知", "Extension result unknown") : text("延长释放失败", "Failed to extend release");
      const detail = error instanceof Error ? error.message : text("请稍后重试", "Try again later");
      toast.error(
        title,
        unknown
          ? text(`${name}：${detail}。请刷新后核对释放时间，再决定是否重试。`, `${name}: ${detail}. Refresh and check the release time before retrying.`)
          : `${name}: ${detail}`,
      );
      void runLogger.log({
        source: "task",
        level: unknown ? "warning" : "error",
        action: "task.extendRelease",
        result: "failure",
        title,
        targetName: name,
        targetId: task.id,
        error: errorMessage(error, text("延长释放失败", "Failed to extend release")),
      });
      if (unknown) invalidateTaskQueries(queryClient);
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
