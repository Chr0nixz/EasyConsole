import { describe, expect, it } from "vitest";

import { countFirstDayRuns, estimateScheduleCost, FIRST_DAY_RUN_CAP } from "./schedule-cost";

describe("countFirstDayRuns", () => {
  const start = "2026-11-10T09:00";

  it("counts one run a day for a daily plan", () => {
    expect(countFirstDayRuns(start, { type: "daily" })).toBe(1);
  });

  it("counts every interval run inside the first 24 hours", () => {
    expect(countFirstDayRuns(start, { type: "interval", intervalSec: 3600 })).toBe(24);
  });

  it("caps a per-minute cron so the preview stays cheap", () => {
    expect(countFirstDayRuns(start, { type: "cron", cron: "* * * * *" })).toBe(FIRST_DAY_RUN_CAP);
  });

  it("returns null for an invalid start or rule", () => {
    expect(countFirstDayRuns("not a date", { type: "daily" })).toBeNull();
    expect(countFirstDayRuns(start, { type: "weekly", weekdays: [] })).toBeNull();
  });
});

describe("estimateScheduleCost", () => {
  it("prices a timed release at 24 hours per run", () => {
    expect(estimateScheduleCost({ rate: 48, releaseCondition: 2, runsPerDay: null })).toEqual({ perRun: 1152, perDay: null });
    expect(estimateScheduleCost({ rate: 48, releaseCondition: 2, runsPerDay: 24 })).toEqual({ perRun: 1152, perDay: 27648 });
  });

  it("gives no figure when the length is unknown or the rate is missing", () => {
    expect(estimateScheduleCost({ rate: 48, releaseCondition: 1, runsPerDay: 3 })).toEqual({ perRun: null, perDay: null });
    expect(estimateScheduleCost({ rate: 48, releaseCondition: 3, runsPerDay: 3 })).toEqual({ perRun: null, perDay: null });
    expect(estimateScheduleCost({ rate: null, releaseCondition: 2, runsPerDay: 3 })).toEqual({ perRun: null, perDay: null });
  });
});
