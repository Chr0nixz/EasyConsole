import { describe, expect, it } from "vitest";

import { applyScheduledReleasePolicy, getScheduledReleaseTime } from "./scheduled-release";

describe("scheduled release policy", () => {
  it("fixes the release time at 24 hours after the scheduled execution", () => {
    expect(getScheduledReleaseTime("2026-08-19T10:30")).toBe("2026-08-20T10:30");
  });

  it("writes the fixed release time for timed-release payloads", () => {
    expect(
      applyScheduledReleasePolicy(
        { name: "train", releace_conditions: 2, releace_time: "2026-08-19 10:30:00" },
        "2026-08-19T10:30",
      ),
    ).toMatchObject({ releace_time: "2026-08-20 10:30:00" });
  });

  it("counts from a run's actual start when given a moment", () => {
    const startedAt = new Date(2026, 7, 21, 9, 15);
    expect(getScheduledReleaseTime(startedAt)).toBe("2026-08-22T09:15");
    expect(
      applyScheduledReleasePolicy({ name: "train", releace_conditions: 2, releace_time: "2026-08-19 10:30:00" }, startedAt),
    ).toMatchObject({ releace_time: "2026-08-22 09:15:00" });
  });

  it("does not change payloads using another release condition", () => {
    const payload = { name: "train", releace_conditions: 1, releace_time: undefined };
    expect(applyScheduledReleasePolicy(payload, "2026-08-19T10:30")).toBe(payload);
  });
});
