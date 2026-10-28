import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAccountScope, setActiveAccountScope } from "./account-scope";
import { instanceApi } from "./api";
import { taskLogPollInterval, taskLogQueryOptions, type TaskLogSnapshot } from "./task-log-query";
import type { Task } from "./types";

vi.mock("./api", () => ({ instanceApi: { taskLog: vi.fn() } }));

const task = { id: 7, task_id: 12 } as Task;

afterEach(() => {
  resetAccountScope();
  vi.clearAllMocks();
});

describe("task log query", () => {
  it("backs off for large, unchanged, and failed full-snapshot reads", () => {
    expect(taskLogPollInterval()).toBe(6_000);
    expect(taskLogPollInterval({ text: "x".repeat(200_000), unchangedReads: 0 })).toBe(15_000);
    expect(taskLogPollInterval({ text: "x".repeat(1_000_000), unchangedReads: 0 })).toBe(30_000);
    expect(taskLogPollInterval({ text: "x".repeat(5_000_000), unchangedReads: 0 })).toBe(60_000);
    expect(taskLogPollInterval({ text: "unchanged", unchangedReads: 1 })).toBe(12_000);
    expect(taskLogPollInterval({ text: "unchanged", unchangedReads: 4 })).toBe(60_000);
    expect(taskLogPollInterval({ text: "short", unchangedReads: 0 }, true)).toBe(60_000);
  });

  it("tracks unchanged snapshots and resets the backoff when the log grows", async () => {
    vi.mocked(instanceApi.taskLog)
      .mockResolvedValueOnce("same")
      .mockResolvedValueOnce("same")
      .mockResolvedValueOnce("new output");
    const client = new QueryClient();
    const options = taskLogQueryOptions(task, true);

    await client.fetchQuery({ ...options, staleTime: 0 });
    expect(client.getQueryData<TaskLogSnapshot>(options.queryKey)).toEqual({ text: "same", unchangedReads: 0 });
    await client.fetchQuery({ ...options, staleTime: 0 });
    expect(client.getQueryData<TaskLogSnapshot>(options.queryKey)).toEqual({ text: "same", unchangedReads: 1 });
    await client.fetchQuery({ ...options, staleTime: 0 });
    expect(client.getQueryData<TaskLogSnapshot>(options.queryKey)).toEqual({ text: "new output", unchangedReads: 0 });
    expect(vi.mocked(instanceApi.taskLog).mock.calls[0]?.[0]).toBe(task);
    expect(vi.mocked(instanceApi.taskLog).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    client.clear();
  });

  it("uses an account-scoped key and disables polling when not following", () => {
    setActiveAccountScope({ key: "alice@console.example/api", displayName: "Alice" });
    const options = taskLogQueryOptions(task, false);

    expect(options.queryKey).toEqual(["account", "alice@console.example/api", "tasks", "log", "12"]);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.gcTime).toBe(0);
  });

  it("backs off failed live reads and polls changed snapshots at their size-based cadence", () => {
    const options = taskLogQueryOptions(task, true);
    if (typeof options.refetchInterval !== "function") throw new Error("Expected a live polling callback");
    const poll = options.refetchInterval as (query: { state: { data?: TaskLogSnapshot; status: string } }) => number;

    expect(poll({ state: { status: "error" } })).toBe(60_000);
    expect(poll({ state: { status: "success", data: { text: "x".repeat(250_000), unchangedReads: 0 } } })).toBe(15_000);
  });
});
