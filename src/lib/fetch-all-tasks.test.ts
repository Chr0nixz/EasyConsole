import { describe, expect, it, vi } from "vitest";

import { fetchAllTasks, FETCH_ALL_TASKS_PAGE_SIZE } from "./fetch-all-tasks";
import type { Task } from "./types";

function makeTasks(start: number, count: number): Task[] {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    name: `task-${start + index}`,
    status: 2,
  }));
}

describe("fetchAllTasks", () => {
  it("merges multiple pages until a short page", async () => {
    const tasks = vi.fn(async ({ page }: { page?: number }) => {
      if (page === 1) return { items: makeTasks(1, FETCH_ALL_TASKS_PAGE_SIZE), total: 150, raw: { page: 1 } };
      if (page === 2) return { items: makeTasks(101, 50), total: 150, raw: { page: 2 } };
      return { items: [], total: 150, raw: { page } };
    });

    const result = await fetchAllTasks({ tasks });

    expect(tasks).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(150);
    expect(result.items[0]?.id).toBe(1);
    expect(result.items[149]?.id).toBe(150);
    expect(result.total).toBe(150);
  });

  it("stops when accumulated items reach reported total", async () => {
    const tasks = vi.fn(async ({ page }: { page?: number }) => {
      if (page === 1) return { items: makeTasks(1, 100), total: 100, raw: null };
      return { items: makeTasks(101, 100), total: 100, raw: null };
    });

    const result = await fetchAllTasks({ tasks });

    expect(tasks).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(100);
  });

  it("respects maxPages safety cap", async () => {
    const tasks = vi.fn(async () => ({ items: makeTasks(1, 10), total: 1000, raw: null }));

    const result = await fetchAllTasks({ tasks }, { pageSize: 10, maxPages: 3 });

    expect(tasks).toHaveBeenCalledTimes(3);
    expect(result.items).toHaveLength(30);
    expect(result.pagesFetched).toBe(3);
  });

  it("stops when AbortSignal aborts", async () => {
    const controller = new AbortController();
    const tasks = vi.fn(async () => {
      controller.abort();
      return { items: makeTasks(1, 10), total: 1000, raw: null };
    });

    await expect(fetchAllTasks({ tasks }, { pageSize: 10, maxPages: 5, signal: controller.signal })).rejects.toThrow();
  });

  it("stops when time budget is exceeded", async () => {
    const tasks = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { items: makeTasks(1, 10), total: 1000, raw: null };
    });

    const result = await fetchAllTasks({ tasks }, { pageSize: 10, maxPages: 50, timeBudgetMs: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.pagesFetched).toBeLessThanOrEqual(2);
  });
});
