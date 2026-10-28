import { queryOptions } from "@tanstack/react-query";

import { instanceApi } from "./api";
import { queryKeys } from "./query-keys";
import type { Task } from "./types";

export type TaskLogSnapshot = { text: string; unchangedReads: number };

/** The API only offers full snapshots; avoid downloading idle/large logs every six seconds. */
export function taskLogPollInterval(snapshot?: TaskLogSnapshot, failed = false): number {
  if (failed) return 60_000;
  const chars = snapshot?.text.length ?? 0;
  const base = chars >= 5_000_000 ? 60_000 : chars >= 1_000_000 ? 30_000 : chars >= 200_000 ? 15_000 : 6_000;
  return Math.min(60_000, base * 2 ** (snapshot?.unchangedReads ?? 0));
}

export function taskLogQueryOptions(task: Pick<Task, "id" | "task_id">, live: boolean) {
  const queryKey = queryKeys.tasks.log(task.task_id ?? task.id);
  return queryOptions({
    queryKey,
    queryFn: async ({ signal, client }): Promise<TaskLogSnapshot> => {
      const previous = client.getQueryData<TaskLogSnapshot>(queryKey);
      const text = await instanceApi.taskLog(task, { signal });
      return { text, unchangedReads: previous?.text === text ? Math.min(previous.unchangedReads + 1, 4) : 0 };
    },
    staleTime: 6_000,
    gcTime: 0,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: live
      ? (query) => taskLogPollInterval(query.state.data, query.state.status === "error")
      : false,
  });
}
