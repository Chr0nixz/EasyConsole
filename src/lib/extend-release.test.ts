import { describe, expect, it, vi } from "vitest";

import { extendTimedRelease, ExtendReleaseRefusedError } from "./extend-release";
import { TIMED_RELEASE_CONDITION } from "./task-release-notifications";
import type { Task } from "./types";

function timedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    task_id: "task-7",
    name: "train",
    status: 2,
    releace_conditions: TIMED_RELEASE_CONDITION,
    releace_time: "2026-11-25 12:00:00",
    ...overrides,
  } as Task;
}

// Local wall clock, like the backend's release times.
const NOW = new Date(2026, 10, 25, 11, 0, 0).getTime();

function deps(lists: Array<Task[] | Error>) {
  const loadTasks = vi.fn(async () => {
    const next = lists.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  });
  const updateTask = vi.fn(async () => ({}));
  return { loadTasks, updateTask, now: () => NOW };
}

describe("extendTimedRelease", () => {
  it("writes the extension from the backend's current state and confirms it was stored", async () => {
    const d = deps([[timedTask()], [timedTask({ releace_time: "2026-11-25 13:00:00" })]]);

    const result = await extendTimedRelease(timedTask(), 1, d);

    expect(d.updateTask).toHaveBeenCalledWith(7, { releace_time: "2026-11-25 13:00:00" });
    expect(result.verification).toBe("confirmed");
    expect(result.backendReleaseAt).toBe(new Date(2026, 10, 25, 13, 0, 0).getTime());
  });

  it("writes nothing when the release time was already changed elsewhere", async () => {
    // Someone extended it to tomorrow. Extending the stale snapshot (today 12:00) by one hour
    // would move the release back to today 13:00 and free the instance a day early.
    const d = deps([[timedTask({ releace_time: "2026-11-26 12:00:00" })]]);

    const error = await extendTimedRelease(timedTask(), 1, d).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtendReleaseRefusedError);
    expect((error as ExtendReleaseRefusedError).reason).toBe("changed");
    expect((error as ExtendReleaseRefusedError).latestReleaseAt).toBe(new Date(2026, 10, 26, 12, 0, 0).getTime());
    expect(d.updateTask).not.toHaveBeenCalled();
  });

  it("writes nothing when the instance is gone or no longer a live timed release", async () => {
    const missing = deps([[timedTask({ id: 8, task_id: "task-8" })]]);
    await expect(extendTimedRelease(timedTask(), 1, missing)).rejects.toMatchObject({ reason: "missing" });
    expect(missing.updateTask).not.toHaveBeenCalled();

    const released = deps([[timedTask({ status: 4 })]]);
    await expect(extendTimedRelease(timedTask(), 1, released)).rejects.toMatchObject({ reason: "not-extendable" });
    expect(released.updateTask).not.toHaveBeenCalled();
  });

  it("reports a mismatch when the backend still holds another release time", async () => {
    const d = deps([[timedTask()], [timedTask()]]);

    const result = await extendTimedRelease(timedTask(), 1, d);

    expect(d.updateTask).toHaveBeenCalledTimes(1);
    expect(result.verification).toBe("mismatch");
    expect(result.backendReleaseAt).toBe(new Date(2026, 10, 25, 12, 0, 0).getTime());
  });

  it("marks the result unchecked when the release time cannot be read back", async () => {
    const d = deps([[timedTask()], new Error("network down")]);

    const result = await extendTimedRelease(timedTask(), 3, d);

    expect(d.updateTask).toHaveBeenCalledWith(7, { releace_time: "2026-11-25 15:00:00" });
    expect(result.verification).toBe("unchecked");
    expect(result.backendReleaseAt).toBeNull();
  });
});
