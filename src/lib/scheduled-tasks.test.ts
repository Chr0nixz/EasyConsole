import { describe, afterEach, expect, it } from "vitest";

import { resetAccountScope, setActiveAccountScope } from "./account-scope";
import {
  LEGACY_SCHEDULED_TASK_OWNER,
  SCHEDULED_TASKS_STORAGE_KEY,
  createScheduledTask,
  holdScheduledTaskForReview,
  isScheduleDue,
  loadScheduledTasks,
  mutateScheduledTasks,
  normalizeRecurrence,
  pauseScheduledTask,
  resumeScheduledTask,
  saveScheduledTasks,
  scheduledTaskOwnerMismatch,
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

describe("scheduled task owner", () => {
  afterEach(() => {
    resetAccountScope();
  });

  it("migrates ownerless legacy records to the legacy/unknown marker on load", async () => {
    const storage = createMemoryStorage();
    const legacy = makeTask({ id: "legacy-1" });
    expect(legacy.owner).toBeUndefined();
    await storage.set(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([legacy]));

    const loaded = await loadScheduledTasks(storage);

    expect(loaded[0]?.owner).toEqual(LEGACY_SCHEDULED_TASK_OWNER);
    expect(loaded[0]?.owner?.key).toBe("legacy");
  });

  it("round-trips a recorded owner", async () => {
    const storage = createMemoryStorage();
    const owner = { key: "alice@console.example/api", displayName: "Alice" };
    await saveScheduledTasks(storage, [makeTask({ owner })]);

    const loaded = await loadScheduledTasks(storage);

    expect(loaded[0]?.owner).toEqual(owner);
  });

  it("stamps the active account on newly created schedules", () => {
    setActiveAccountScope({ key: "alice@console", displayName: "Alice" });
    const task = createScheduledTask({ name: "train", scheduleTime: "2026-05-24T10:00", payload: { name: "train" } });
    expect(task.owner).toEqual({ key: "alice@console", displayName: "Alice" });
  });

  it("falls back to the legacy owner when created without a signed-in account", () => {
    const task = createScheduledTask({ name: "train", scheduleTime: "2026-05-24T10:00", payload: { name: "train" } });
    expect(task.owner).toEqual(LEGACY_SCHEDULED_TASK_OWNER);
  });

  it("accepts an explicit owner override", () => {
    setActiveAccountScope({ key: "bob@console", displayName: "Bob" });
    const task = createScheduledTask({
      name: "train",
      scheduleTime: "2026-05-24T10:00",
      payload: { name: "train" },
      owner: { key: "alice@console", displayName: "Alice" },
    });
    expect(task.owner).toEqual({ key: "alice@console", displayName: "Alice" });
  });

  it("flags mismatched and legacy owners with a migration reason", () => {
    setActiveAccountScope({ key: "bob@console", displayName: "Bob" });

    const mismatch = scheduledTaskOwnerMismatch(makeTask({ owner: { key: "alice@console", displayName: "Alice" } }));
    expect(mismatch?.reason).toContain("Alice");
    expect(mismatch?.reason).toContain("Bob");

    const legacy = scheduledTaskOwnerMismatch(makeTask({}));
    expect(legacy?.reason).toBeTruthy();

    expect(scheduledTaskOwnerMismatch(makeTask({ owner: { key: "bob@console", displayName: "Bob" } }))).toBeNull();
  });

  it("flags every task when nobody is signed in", () => {
    const reason = scheduledTaskOwnerMismatch(makeTask({ owner: { key: "alice@console", displayName: "Alice" } }));
    expect(reason?.reason).toBeTruthy();
  });

  it("adopts the current account when resuming a held task (migration path)", () => {
    setActiveAccountScope({ key: "bob@console", displayName: "Bob" });
    const held = makeTask({
      status: "needs_review",
      owner: { key: "alice@console", displayName: "Alice" },
      lastError: "held for review",
    });

    const resumed = resumeScheduledTask(held);

    expect(resumed.status).toBe("pending");
    expect(resumed.owner).toEqual({ key: "bob@console", displayName: "Bob" });
    expect(resumed.lastError).toBeUndefined();
    expect(scheduledTaskOwnerMismatch(resumed)).toBeNull();
  });

  it("keeps the stored owner when resuming outside a signed-in session (CLI/MCP)", () => {
    const owner = { key: "alice@console", displayName: "Alice" };
    const resumed = resumeScheduledTask(makeTask({ status: "paused", owner }));
    expect(resumed.owner).toEqual(owner);
  });

  it("holds a mismatched task for review without executing it", () => {
    const held = holdScheduledTaskForReview(makeTask({ status: "pending" }), "owner mismatch", new Date("2026-05-24T12:00:00Z"));
    expect(held.status).toBe("needs_review");
    expect(held.lastError).toBe("owner mismatch");
    expect(isScheduleDue(held, new Date("2026-05-24T13:00:00"))).toBe(false);
  });
});
