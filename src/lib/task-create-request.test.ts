import { describe, expect, it, vi } from "vitest";

import { consumePendingCreateTaskRequest, requestCreateTask, subscribeCreateTaskRequests } from "./task-create-request";

describe("task create request", () => {
  it("keeps a request made before the task list mounts, once", () => {
    requestCreateTask();
    expect(consumePendingCreateTaskRequest()).toBe(true);
    expect(consumePendingCreateTaskRequest()).toBe(false);
  });

  it("delivers a request to a mounted task list instead of queueing it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCreateTaskRequests(listener);
    requestCreateTask();
    expect(listener).toHaveBeenCalledOnce();
    expect(consumePendingCreateTaskRequest()).toBe(false);
    unsubscribe();
  });
});
