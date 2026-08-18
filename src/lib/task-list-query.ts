import { getTaskName } from "./format";
import type { Task, TaskQuery } from "./types";

export const DEFAULT_TASK_PAGE = 1;
export const DEFAULT_TASK_PAGE_SIZE = 50;
export const TASK_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

export type TaskListSortBy = "" | "name" | "status" | "created" | "updated";
export type TaskListSortDir = "asc" | "desc";

export type TaskListQueryState = {
  page: number;
  pageSize: number;
  keyword: string;
  status: string;
  sortBy: TaskListSortBy;
  sortDir: TaskListSortDir;
};

function positiveInteger(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function pageSize(value: string | null) {
  const number = positiveInteger(value, DEFAULT_TASK_PAGE_SIZE);
  return TASK_PAGE_SIZE_OPTIONS.includes(number as (typeof TASK_PAGE_SIZE_OPTIONS)[number]) ? number : DEFAULT_TASK_PAGE_SIZE;
}

const SORT_BY_VALUES = ["name", "status", "created", "updated"] as const satisfies readonly Exclude<TaskListSortBy, "">[];

function parseSortBy(value: string | null): TaskListSortBy {
  if (value && (SORT_BY_VALUES as readonly string[]).includes(value)) return value as TaskListSortBy;
  return "";
}

function parseSortDir(value: string | null): TaskListSortDir {
  return value === "asc" || value === "desc" ? value : "desc";
}

export function parseTaskListQuery(params: URLSearchParams): TaskListQueryState {
  return {
    page: positiveInteger(params.get("page"), DEFAULT_TASK_PAGE),
    pageSize: pageSize(params.get("pageSize")),
    keyword: params.get("keyword")?.trim() ?? "",
    status: params.get("status")?.trim() ?? "",
    sortBy: parseSortBy(params.get("sortBy")),
    sortDir: parseSortDir(params.get("sortDir")),
  };
}

export function serializeTaskListQuery(state: TaskListQueryState) {
  const params = new URLSearchParams();
  if (state.page > DEFAULT_TASK_PAGE) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_TASK_PAGE_SIZE) params.set("pageSize", String(state.pageSize));
  if (state.keyword.trim()) params.set("keyword", state.keyword.trim());
  if (state.status) params.set("status", state.status);
  if (state.sortBy) {
    params.set("sortBy", state.sortBy);
    if (state.sortDir !== "desc") params.set("sortDir", state.sortDir);
  }
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

function taskTimestamp(task: Task, field: "created" | "updated") {
  const raw =
    field === "created"
      ? (task.create_time ?? task.created_at)
      : (task.update_time ?? task.create_time ?? task.created_at);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Client-side sort for the current page only (backend order_by not assumed). */
export function sortTasksClientSide(tasks: Task[], sortBy: TaskListSortBy, sortDir: TaskListSortDir) {
  if (!sortBy) return tasks;
  const direction = sortDir === "asc" ? 1 : -1;
  return [...tasks].sort((left, right) => {
    let cmp = 0;
    if (sortBy === "name") {
      cmp = getTaskName(left).localeCompare(getTaskName(right), undefined, { sensitivity: "base" });
    } else if (sortBy === "status") {
      cmp = Number(left.status ?? 0) - Number(right.status ?? 0);
    } else if (sortBy === "created") {
      cmp = taskTimestamp(left, "created") - taskTimestamp(right, "created");
    } else if (sortBy === "updated") {
      cmp = taskTimestamp(left, "updated") - taskTimestamp(right, "updated");
    }
    return cmp * direction;
  });
}
