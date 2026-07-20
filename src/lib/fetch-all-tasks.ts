import type { EasyConsoleApi } from "./api-factory";
import type { ListResult, Task, TaskQuery } from "./types";

export const FETCH_ALL_TASKS_PAGE_SIZE = 100;
export const FETCH_ALL_TASKS_MAX_PAGES = 50;

type TasksClient = Pick<EasyConsoleApi["instanceApi"], "tasks">;

export type FetchAllTasksOptions = {
  pageSize?: number;
  maxPages?: number;
  query?: Omit<TaskQuery, "page" | "page_size">;
};

/**
 * Page through instance tasks until a short page or the safety page cap.
 * Used by background notification watching so status changes beyond page 1 are visible.
 */
export async function fetchAllTasks(
  api: TasksClient,
  options: FetchAllTasksOptions = {},
): Promise<ListResult<Task>> {
  const pageSize = options.pageSize ?? FETCH_ALL_TASKS_PAGE_SIZE;
  const maxPages = options.maxPages ?? FETCH_ALL_TASKS_MAX_PAGES;
  const items: Task[] = [];
  let total: number | undefined;
  let raw: unknown = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await api.tasks({
      ...options.query,
      page,
      page_size: pageSize,
    });
    raw = result.raw;
    if (result.total !== undefined) total = result.total;
    items.push(...result.items);
    if (result.items.length < pageSize) break;
    if (total !== undefined && items.length >= total) break;
  }

  return { items, total, raw };
}
