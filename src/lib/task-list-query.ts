import type { Task, TaskQuery } from "./types";

export const DEFAULT_TASK_PAGE = 1;
export const DEFAULT_TASK_PAGE_SIZE = 50;
export const TASK_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

export type TaskListQueryState = {
  page: number;
  pageSize: number;
  keyword: string;
  status: string;
};

function positiveInteger(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function pageSize(value: string | null) {
  const number = positiveInteger(value, DEFAULT_TASK_PAGE_SIZE);
  return TASK_PAGE_SIZE_OPTIONS.includes(number as (typeof TASK_PAGE_SIZE_OPTIONS)[number]) ? number : DEFAULT_TASK_PAGE_SIZE;
}

export function parseTaskListQuery(params: URLSearchParams): TaskListQueryState {
  return {
    page: positiveInteger(params.get("page"), DEFAULT_TASK_PAGE),
    pageSize: pageSize(params.get("pageSize")),
    keyword: params.get("keyword")?.trim() ?? "",
    status: params.get("status")?.trim() ?? "",
  };
}

export function serializeTaskListQuery(state: TaskListQueryState) {
  const params = new URLSearchParams();
  if (state.page > DEFAULT_TASK_PAGE) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_TASK_PAGE_SIZE) params.set("pageSize", String(state.pageSize));
  if (state.keyword.trim()) params.set("keyword", state.keyword.trim());
  if (state.status) params.set("status", state.status);
  return params;
}

export function toTaskApiQuery(state: TaskListQueryState): TaskQuery {
  return {
    page: state.page,
    page_size: state.pageSize,
    keyword: state.keyword.trim() || undefined,
    status: state.status || undefined,
  };
}

export function taskMatchesQuery(task: Task, state: TaskListQueryState) {
  if (state.status && String(task.status ?? "") !== state.status) return false;
  return true;
}
