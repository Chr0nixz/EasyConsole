import type { EasyConsoleApi } from "./api-factory";
import type { ListResult, Task, TaskQuery } from "./types";

export const FETCH_ALL_TASKS_PAGE_SIZE = 100;
export const FETCH_ALL_TASKS_MAX_PAGES = 50;
/** Soft wall-clock budget for a single full scan (ms). */
export const FETCH_ALL_TASKS_TIME_BUDGET_MS = 20_000;

type TasksClient = Pick<EasyConsoleApi["instanceApi"], "tasks">;

export type FetchAllTasksOptions = {
  pageSize?: number;
  maxPages?: number;
  query?: Omit<TaskQuery, "page" | "page_size">;
  signal?: AbortSignal;
  timeBudgetMs?: number;
};

/**
 * Page through instance tasks until a short page, the safety page cap, abort, or time budget.
 * Used by background notification watching so status changes beyond page 1 are visible.
 */
export async function fetchAllTasks(
  api: TasksClient,
  options: FetchAllTasksOptions = {},
): Promise<ListResult<Task> & { pagesFetched: number; timedOut: boolean }> {
  const pageSize = options.pageSize ?? FETCH_ALL_TASKS_PAGE_SIZE;
  const maxPages = options.maxPages ?? FETCH_ALL_TASKS_MAX_PAGES;
  const timeBudgetMs = options.timeBudgetMs ?? FETCH_ALL_TASKS_TIME_BUDGET_MS;
  const startedAt = Date.now();
  const items: Task[] = [];
  let total: number | undefined;
  let raw: unknown = null;
  let pagesFetched = 0;
  let timedOut = false;

  for (let page = 1; page <= maxPages; page += 1) {
    options.signal?.throwIfAborted();
    if (Date.now() - startedAt >= timeBudgetMs) {
      timedOut = true;
      break;
    }
    const result = await api.tasks({
      ...options.query,
      page,
      page_size: pageSize,
    });
    pagesFetched += 1;
    raw = result.raw;
    if (result.total !== undefined) total = result.total;
    items.push(...result.items);
    if (result.items.length < pageSize) break;
    if (total !== undefined && items.length >= total) break;
  }

  return { items, total, raw, pagesFetched, timedOut };
}
