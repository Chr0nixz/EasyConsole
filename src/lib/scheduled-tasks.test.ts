import { describe, expect, it } from "vitest";

import {
  createScheduledTask,
  isScheduleDue,
  loadScheduledTasks,
  saveScheduledTasks,
  sortScheduledTasks,
  updateScheduledTask,
} from "./scheduled-tasks";
import type { RuntimeStorage, ScheduledTask } from "./types";

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

function makeTask(patch: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "schedule-1",
    name: "train",
    scheduleTime: "2026-05-24T10:00",
    status: "pending",
    payload: { name: "train" },
    createdAt: "2026-05-24T01:00:00.000Z",
    updatedAt: "2026-05-24T01:00:00.000Z",
    ...patch,
  };
}

describe("scheduled tasks", () => {
  it("persists and reloads valid schedules", async () => {
    const storage = createMemoryStorage();
    const task = createScheduledTask({
      name: "train",
      scheduleTime: "2026-05-24T10:00",
      payload: { name: "train", cpu: 4 },
    });

    await saveScheduledTasks(storage, [task]);

    expect(await loadScheduledTasks(storage)).toEqual([task]);
  });

  it("detects due pending tasks only", () => {
    const now = new Date("2026-05-24T10:01:00");

    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:00", status: "pending" }), now)).toBe(true);
    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:02", status: "pending" }), now)).toBe(false);
    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:00", status: "done" }), now)).toBe(false);
  });

  it("keeps active schedules before completed schedules", () => {
    const done = makeTask({ id: "done", status: "done", scheduleTime: "2026-05-24T09:00" });
    const pending = makeTask({ id: "pending", status: "pending", scheduleTime: "2026-05-24T10:00" });

    expect(sortScheduledTasks([done, pending]).map((task) => task.id)).toEqual(["pending", "done"]);
  });

  it("updates one schedule without mutating the rest", () => {
    const first = makeTask({ id: "first" });
    const second = makeTask({ id: "second" });
    const next = updateScheduledTask([first, second], { ...second, status: "failed", lastError: "boom" });

    expect(next[0]).toEqual(first);
    expect(next[1]).toMatchObject({ id: "second", status: "failed", lastError: "boom" });
  });
});
