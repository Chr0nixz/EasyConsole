import { describe, expect, it } from "vitest";

import {
  createScheduledTask,
  isScheduleDue,
  loadScheduledTasks,
  mutateScheduledTasks,
  normalizeRecurrence,
  pauseScheduledTask,
  resumeScheduledTask,
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

  it("returns empty list for corrupt JSON", async () => {
    const storage = createMemoryStorage();
    await storage.set("easy-console.scheduledTasks", "{not-json");
    await expect(loadScheduledTasks(storage)).resolves.toEqual([]);
  });

  it("detects due pending tasks only", () => {
    const now = new Date("2026-05-24T10:01:00");

    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:00", status: "pending" }), now)).toBe(true);
    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:02", status: "pending" }), now)).toBe(false);
    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:00", status: "done" }), now)).toBe(false);
    expect(isScheduleDue(makeTask({ scheduleTime: "2026-05-24T10:00", status: "paused" }), now)).toBe(false);
  });

  it("pauses pending tasks and resumes paused or failed tasks", () => {
    expect(pauseScheduledTask(makeTask({ status: "pending" })).status).toBe("paused");
    expect(pauseScheduledTask(makeTask({ status: "running" })).status).toBe("running");
    expect(resumeScheduledTask(makeTask({ status: "paused" })).status).toBe("pending");
    expect(resumeScheduledTask(makeTask({ status: "failed", lastError: "boom" }))).toMatchObject({
      status: "pending",
      lastError: undefined,
    });
    expect(resumeScheduledTask(makeTask({ status: "needs_review", lastError: "lease" })).status).toBe("pending");
  });

  it("keeps active schedules before completed schedules", () => {
    const done = makeTask({ id: "done", status: "done", scheduleTime: "2026-05-24T09:00" });
    const pending = makeTask({ id: "pending", status: "pending", scheduleTime: "2026-05-24T10:00" });
    const paused = makeTask({ id: "paused", status: "paused", scheduleTime: "2026-05-24T11:00" });

    expect(sortScheduledTasks([done, paused, pending]).map((task) => task.id)).toEqual(["pending", "paused", "done"]);
  });

  it("updates one schedule without mutating the rest", () => {
    const first = makeTask({ id: "first" });
    const second = makeTask({ id: "second" });
    const next = updateScheduledTask([first, second], { ...second, status: "failed", lastError: "boom" });

    expect(next[0]).toEqual(first);
    expect(next[1]).toMatchObject({ id: "second", status: "failed", lastError: "boom" });
  });

  it("merges page edits without clobbering a concurrent runner lease", async () => {
    const storage = createMemoryStorage();
    const other = makeTask({ id: "other", name: "other" });
    const staleSnapshot = [makeTask({ id: "leased" }), other];
    await saveScheduledTasks(storage, staleSnapshot);

    // Background runner records a completed remote create while the page still
    // holds the pre-run snapshot above.
    await saveScheduledTasks(storage, [
      makeTask({ id: "leased", status: "running", executionKey: "leased@2026-05-24T10:00", lastRemoteTaskId: "remote-42" }),
      other,
    ]);

    // Page edits an unrelated row from its stale snapshot.
    const merged = await mutateScheduledTasks(storage, (current) =>
      updateScheduledTask(current, { ...other, status: "paused" }),
    );

    expect(merged.find((item) => item.id === "leased")).toMatchObject({
      status: "running",
      lastRemoteTaskId: "remote-42",
      executionKey: "leased@2026-05-24T10:00",
    });
    expect(merged.find((item) => item.id === "other")?.status).toBe("paused");
  });

  it("degrades incomplete recurrence to a one-shot and marks needs_review", async () => {
    expect(normalizeRecurrence({ type: "weekly", weekdays: [] })).toEqual({
      recurrence: { type: "once" },
      invalid: true,
    });
    expect(normalizeRecurrence({ type: "interval" })).toEqual({
      recurrence: { type: "once" },
      invalid: true,
    });
    expect(normalizeRecurrence({ type: "cron", cron: "" })).toEqual({
      recurrence: { type: "once" },
      invalid: true,
    });

    const storage = createMemoryStorage();
    await storage.set(
      "easy-console.scheduledTasks",
      JSON.stringify([
        makeTask({
          id: "bad-weekly",
          recurrence: { type: "weekly", weekdays: [] },
        }),
      ]),
    );
    const loaded = await loadScheduledTasks(storage);
    expect(loaded[0]).toMatchObject({
      status: "needs_review",
      recurrence: { type: "once" },
    });
    expect(isScheduleDue(loaded[0]!, new Date("2026-05-24T12:00:00"))).toBe(false);
  });

  it("does not throw from isScheduleDue on an in-memory invalid recurrence", () => {
    const task = makeTask({
      recurrence: { type: "weekly", weekdays: [] },
    });
    expect(() => isScheduleDue(task, new Date("2026-05-24T12:00:00"))).not.toThrow();
    expect(isScheduleDue(task, new Date("2026-05-24T12:00:00"))).toBe(false);
  });
});
