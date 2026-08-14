import { describe, expect, it } from "vitest";

import {
  beginScheduledExecution,
  completeScheduledExecution,
  executeScheduledTask,
  makeExecutionKey,
  reconcileStaleRunningTasks,
} from "./schedule-execution";
import { loadScheduledTasks, saveScheduledTasks } from "./scheduled-tasks";
import type { RuntimeStorage, ScheduledTask } from "./types";

function makeTask(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sch-1",
    name: "train",
    scheduleTime: "2026-07-21T10:00:00.000Z",
    status: "pending",
    payload: { name: "train" },
    createdAt: "2026-07-21T01:00:00.000Z",
    updatedAt: "2026-07-21T01:00:00.000Z",
    ...patch,
  };
}

describe("schedule-execution", () => {
  it("builds a stable execution key from id and scheduleTime", () => {
    expect(makeExecutionKey(makeTask())).toBe("sch-1@2026-07-21T10:00:00.000Z");
  });

  it("begins a lease before remote create", () => {
    const now = new Date("2026-07-21T10:01:00.000Z");
    const leased = beginScheduledExecution(makeTask(), now);
    expect(leased.status).toBe("running");
    expect(leased.executionKey).toBe("sch-1@2026-07-21T10:00:00.000Z");
    expect(leased.leaseStartedAt).toBe(now.toISOString());
  });

  it("advances schedule after successful remote create for recurring tasks", () => {
    const task = makeTask({
      status: "running",
      executionKey: "sch-1@2026-07-21T10:00:00.000Z",
      leaseStartedAt: "2026-07-21T10:00:00.000Z",
      recurrence: { type: "interval", intervalSec: 3600 },
    });
    const next = completeScheduledExecution(task, "remote-42", new Date("2026-07-21T10:00:05.000Z"));
    expect(next.lastRemoteTaskId).toBe("remote-42");
    expect(next.status).toBe("pending");
    expect(next.leaseStartedAt).toBeUndefined();
    expect(Date.parse(next.scheduleTime)).toBeGreaterThan(Date.parse(task.scheduleTime));
  });

  it("marks stale running leases as needs_review instead of pending", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const stale = makeTask({
      status: "running",
      executionKey: "sch-1@2026-07-21T10:00:00.000Z",
      leaseStartedAt: "2026-07-21T10:00:00.000Z",
      lastRemoteTaskId: "remote-9",
    });
    const fresh = makeTask({
      id: "sch-2",
      status: "running",
      scheduleTime: "2026-07-21T11:55:00.000Z",
      executionKey: "sch-2@2026-07-21T11:55:00.000Z",
      leaseStartedAt: "2026-07-21T11:55:00.000Z",
    });
    const result = reconcileStaleRunningTasks([stale, fresh], now, 15 * 60 * 1000);
    expect(result[0].status).toBe("needs_review");
    expect(result[0].lastRemoteTaskId).toBe("remote-9");
    expect(result[1].status).toBe("running");
  });

  it("does not auto-replay after needs_review (isScheduleDue false)", async () => {
    const { isScheduleDue } = await import("./scheduled-tasks");
    const task = makeTask({
      status: "needs_review",
      scheduleTime: "2026-07-21T09:00:00.000Z",
      executionKey: "sch-1@2026-07-21T09:00:00.000Z",
      lastRemoteTaskId: "remote-1",
    });
    expect(isScheduleDue(task, new Date("2026-07-21T12:00:00.000Z"))).toBe(false);
  });
});

function createMemoryStorage(): RuntimeStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

describe("executeScheduledTask", () => {
  it("advances a recurring task instead of marking it done", async () => {
    const storage = createMemoryStorage();
    const task = makeTask({
      recurrence: { type: "interval", intervalSec: 3600 },
    });
    await saveScheduledTasks(storage, [task]);
    const now = new Date("2026-07-21T10:00:05.000Z");

    const result = await executeScheduledTask(storage, task.id, {
      createTask: async () => ({ id: "remote-42" }),
      force: true,
      now,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.remoteTaskId).toBe("remote-42");
    expect(result.task.status).toBe("pending");
    expect(Date.parse(result.task.scheduleTime)).toBeGreaterThan(Date.parse(task.scheduleTime));
    expect((await loadScheduledTasks(storage))[0]?.status).toBe("pending");
  });

  it("skips a second claim while a fresh lease is in flight", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    let resumeCreate: () => void = () => undefined;
    let createEntered = false;
    const first = executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        createEntered = true;
        await new Promise<void>((resolve) => {
          resumeCreate = resolve;
        });
        return { id: "remote-1" };
      },
      force: true,
      now: new Date("2026-07-21T10:01:00.000Z"),
    });

    await expect.poll(() => createEntered).toBe(true);

    const second = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-2" }),
      force: true,
      now: new Date("2026-07-21T10:01:01.000Z"),
    });
    expect(second).toMatchObject({ skipped: true, reason: "in-flight" });

    resumeCreate();
    const firstResult = await first;
    expect(firstResult.skipped).toBe(false);
  });

  it("does not replay a needs_review row that already created a remote task", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [
      makeTask({
        status: "needs_review",
        executionKey: "sch-1@2026-07-21T10:00:00.000Z",
        lastRemoteTaskId: "remote-9",
        lastError: "lease expired",
      }),
    ]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-should-not-create" }),
      force: true,
      now: new Date("2026-07-21T10:01:00.000Z"),
    });
    expect(result).toMatchObject({ skipped: true, reason: "already-completed" });
  });
});
