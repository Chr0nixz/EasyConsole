import type { QueryClient } from "@tanstack/react-query";

import type { EasyConsoleApi } from "./api-factory";
import { fetchAllTasks } from "./fetch-all-tasks";
import type { ListResult, Task } from "./types";

export const TASK_SNAPSHOT_QUERY_KEY = ["task-notification-watch"] as const;
export const TASK_SNAPSHOT_POLL_INTERVAL = 10_000;

type TasksClient = Pick<EasyConsoleApi["instanceApi"], "tasks">;

export function taskSnapshotQueryOptions(api: TasksClient) {
  return {
    queryKey: TASK_SNAPSHOT_QUERY_KEY,
    queryFn: (): Promise<ListResult<Task>> => fetchAllTasks(api),
  } as const;
}

/** Invalidate paginated task lists and the shared full-task snapshot together. */
export function invalidateTaskQueries(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  void queryClient.invalidateQueries({ queryKey: TASK_SNAPSHOT_QUERY_KEY });
}
