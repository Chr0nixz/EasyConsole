import { describe, expect, it } from "vitest";

import {
  assertValidCron,
  computeNextRunTime,
  previewNextRuns,
  RecurrenceValidationError,
  validateRecurrence,
} from "./task-recurrence";
import type { CreateTaskPayload, ScheduledTask } from "./types";

const payload = { name: "demo" } as CreateTaskPayload;

function makeTask(partial: Partial<ScheduledTask> & Pick<ScheduledTask, "scheduleTime" | "recurrence">): ScheduledTask {
  return {
    id: "t1",
    name: "demo",
    status: "pending",
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("task-recurrence", () => {
  it("accepts step cron expressions like */30", () => {
    expect(() => assertValidCron("*/30 * * * *")).not.toThrow();
    const task = makeTask({
      scheduleTime: "2026-07-21T10:00:00.000Z",
      recurrence: { type: "cron", cron: "*/30 * * * *" },
    });
    const after = new Date("2026-07-21T10:05:00");
    const next = computeNextRunTime(task, after);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(30);
  });

  it("supports range and list cron fields", () => {
    expect(() => assertValidCron("0 9-17 * * 1,3,5")).not.toThrow();
  });

  it("computes next Monday for 0 0 * * 1 from a Tuesday", () => {
    // Tuesday 2026-07-21 local — use fixed local construction
    const tuesday = new Date(2026, 6, 21, 12, 0, 0); // month 6 = July
    expect(tuesday.getDay()).toBe(2);
    const task = makeTask({
      scheduleTime: new Date(2026, 6, 21, 0, 0, 0).toISOString(),
      recurrence: { type: "cron", cron: "0 0 * * 1" },
    });
    const next = computeNextRunTime(task, tuesday);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1);
    expect(next!.getHours()).toBe(0);
    expect(next!.getMinutes()).toBe(0);
    // Should be the following Monday (Jul 27), not Wednesday
    expect(next!.getDate()).toBe(27);
  });

  it("rejects weekly recurrence with empty weekdays", () => {
    expect(() => validateRecurrence({ type: "weekly", weekdays: [] })).toThrow(RecurrenceValidationError);
    const task = makeTask({
      scheduleTime: "2026-07-21T10:00:00.000Z",
      recurrence: { type: "weekly", weekdays: [] },
    });
    expect(() => computeNextRunTime(task, new Date("2026-07-21T10:00:00.000Z"))).toThrow(RecurrenceValidationError);
  });

  it("finds next weekday for weekly recurrence", () => {
    const wednesday = new Date(2026, 6, 22, 8, 0, 0); // Wed
    const task = makeTask({
      scheduleTime: new Date(2026, 6, 20, 9, 30, 0).toISOString(),
      recurrence: { type: "weekly", weekdays: [1, 5] }, // Mon, Fri
    });
    const next = computeNextRunTime(task, wednesday);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(5);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(30);
  });

  it("handles month-end daily rollover into next month", () => {
    const endOfJan = new Date(2026, 0, 31, 12, 0, 0);
    const task = makeTask({
      scheduleTime: new Date(2026, 0, 31, 9, 0, 0).toISOString(),
      lastRunAt: new Date(2026, 0, 31, 9, 0, 0).toISOString(),
      recurrence: { type: "daily" },
    });
    const next = computeNextRunTime(task, endOfJan);
    expect(next).not.toBeNull();
    expect(next!.getMonth()).toBe(1);
    expect(next!.getDate()).toBe(1);
  });

  it("previews multiple future runs for cron", () => {
    const task = makeTask({
      scheduleTime: "2026-07-21T00:00:00.000Z",
      recurrence: { type: "cron", cron: "0 * * * *" },
    });
    const runs = previewNextRuns(task, 3, new Date(2026, 6, 21, 10, 15, 0));
    expect(runs).toHaveLength(3);
    expect(runs[0].getMinutes()).toBe(0);
    expect(runs[1].getTime()).toBeGreaterThan(runs[0].getTime());
  });

  it("rejects invalid cron", () => {
    expect(() => assertValidCron("not-a-cron")).toThrow(RecurrenceValidationError);
  });
});
