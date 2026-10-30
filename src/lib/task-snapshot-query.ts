import type { QueryClient } from "@tanstack/react-query";

import type { EasyConsoleApi } from "./api-factory";
import { getActiveAccountScope } from "./account-scope";
import { fetchAllTasks } from "./fetch-all-tasks";
import { queryKeys } from "./query-keys";
import type { ListResult, Task } from "./types";

/**
 * Cache key for the shared full-task snapshot. Account-scoped like every other
 * query key so a snapshot fetched for one account is never reused for another.
 */
export function taskSnapshotQueryKey() {
  return ["account", getActiveAccountScope().key, "task-notification-watch"] as const;
}
export const TASK_SNAPSHOT_POLL_INTERVAL = 10_000;
export const TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MIN = 60_000;
export const TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX = 5 * 60_000;

type TasksClient = Pick<EasyConsoleApi["instanceApi"], "tasks">;

/** Prefer active / recent tasks when the backend accepts status filters. */
const ACTIVE_TASK_QUERY = {
  // Backend spelling varies; unknown fields are ignored by tolerant APIs.
  status: "running,pending,creating,starting",
} as const;

export function taskSnapshotQueryOptions(api: TasksClient) {
  return {
    queryKey: taskSnapshotQueryKey(),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<ListResult<Task>> =>
      fetchAllTasks(api, { signal, query: ACTIVE_TASK_QUERY as never }),
  } as const;
}

export function nextNotificationPollInterval(previousMs: number, hidden: boolean): number {
  if (!hidden) return TASK_SNAPSHOT_POLL_INTERVAL;
  const next = Math.max(previousMs, TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MIN) * 2;
  return Math.min(TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX, next);
}

/** Invalidate paginated task lists and the shared full-task snapshot together. */
export function invalidateTaskQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  void queryClient.invalidateQueries({ queryKey: taskSnapshotQueryKey() });
}
