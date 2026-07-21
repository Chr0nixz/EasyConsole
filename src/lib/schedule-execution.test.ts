import { describe, expect, it } from "vitest";

import {
  beginScheduledExecution,
  completeScheduledExecution,
  makeExecutionKey,
  reconcileStaleRunningTasks,
} from "./schedule-execution";
import type { ScheduledTask } from "./types";

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
