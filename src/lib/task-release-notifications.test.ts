import { describe, expect, it } from "vitest";

import {
  canExtendRelease,
  formatReleaseCountdown,
  formatReleaseMoment,
  formatReleaseTimeInput,
  getExtendedReleaseAt,
  getExtensionCost,
  getLiveTimedReleaseAt,
  getUpcomingTimedReleaseNotification,
  parseReleaseTime,
  TIMED_RELEASE_CONDITION,
} from "./task-release-notifications";
import type { Task } from "./types";

const LEAD_MS = 10 * 60_000;

function timedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    task_id: "task-7",
    name: "train",
    status: 2,
    releace_conditions: TIMED_RELEASE_CONDITION,
    ...overrides,
  } as Task;
}

describe("parseReleaseTime", () => {
  it("parses the backend's space-separated local wall clock format", () => {
    expect(parseReleaseTime({ releace_time: "2026-10-26 10:00:00" })).toBe(Date.parse("2026-10-26T10:00:00"));
  });

  it("parses ISO strings and rejects missing or malformed values", () => {
    expect(parseReleaseTime({ releace_time: "2026-10-26T10:00:00" })).toBe(Date.parse("2026-10-26T10:00:00"));
    expect(parseReleaseTime({ releace_time: null })).toBeNull();
    expect(parseReleaseTime({ releace_time: undefined })).toBeNull();
    expect(parseReleaseTime({ releace_time: "not a time" })).toBeNull();
    expect(parseReleaseTime({ releace_time: "" })).toBeNull();
  });
});

describe("formatReleaseTimeInput", () => {
  it("round-trips a parsed release time in the backend's format", () => {
    const raw = "2026-10-26 10:00:00";
    expect(formatReleaseTimeInput(new Date(parseReleaseTime({ releace_time: raw })!))).toBe(raw);
  });
});

describe("release extension", () => {
  const now = Date.parse("2026-10-26T09:55:00");

  it("extends only live timed releases", () => {
    expect(canExtendRelease(timedTask())).toBe(true);
    expect(canExtendRelease(timedTask({ status: 7 }))).toBe(false);
    expect(canExtendRelease(timedTask({ releace_conditions: 1 }))).toBe(false);
  });

  it("adds the hours to the release time, or to now when it is overdue or unreadable", () => {
    expect(getExtendedReleaseAt({ releace_time: "2026-10-26 10:00:00" }, 1, now)).toBe(Date.parse("2026-10-26T11:00:00"));
    expect(getExtendedReleaseAt({ releace_time: "2026-10-26 09:00:00" }, 3, now)).toBe(now + 3 * 3_600_000);
    expect(getExtendedReleaseAt({ releace_time: "soon" }, 24, now)).toBe(now + 24 * 3_600_000);
  });

  it("prices the extra hours at the instance's own rate", () => {
    expect(getExtensionCost({ price: 48 }, 3)).toBe(144);
    expect(getExtensionCost({ price: "12.5" }, 1)).toBe(12.5);
    expect(getExtensionCost({}, 1)).toBeNull();
  });

  it("formats a release moment for reading", () => {
    expect(formatReleaseMoment(Date.parse("2026-10-26T10:00:00"), "zh-CN")).toBe("10/26 10:00");
    expect(formatReleaseMoment(Date.parse("2026-10-26T10:00:00"), "en-US")).toBe("10/26, 10:00");
  });
});

describe("getUpcomingTimedReleaseNotification", () => {
  const now = Date.parse("2026-10-26T09:55:00");
  const inFive = "2026-10-26 10:00:00";

  it("warns for a live timed release inside the lead window", () => {
    const notification = getUpcomingTimedReleaseNotification(timedTask({ releace_time: inFive }), now, LEAD_MS, "zh-CN");
    expect(notification).not.toBeNull();
    expect(notification!.routeId).toBe("7");
    expect(notification!.taskId).toBe("task-7");
    expect(notification!.body).toContain("10/26 10:00");
    // The system notification has no buttons, so its body carries the consequence.
    expect(notification!.body).toContain("数据会被清理");
    expect(notification!.dedupeKey).toBe(`7@${inFive}`);
  });

  it("localizes the copy", () => {
    const notification = getUpcomingTimedReleaseNotification(timedTask({ releace_time: inFive }), now, LEAD_MS, "en-US");
    expect(notification!.title).toBe("Timed release approaching");
    expect(notification!.body).toContain("train");
  });

  it("ignores tasks outside the window, already expired, or on other release conditions", () => {
    const farOut = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: "2026-10-26 11:00:00" }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(farOut).toBeNull();

    const expired = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: "2026-10-26 09:00:00" }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(expired).toBeNull();

    const manual = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: inFive, releace_conditions: 1 }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(manual).toBeNull();

    const afterRelease = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: inFive, releace_conditions: 3 }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(afterRelease).toBeNull();
  });

  it("ignores ended tasks and unparsable times", () => {
    const released = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: inFive, status: 4 }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(released).toBeNull();

    const broken = getUpcomingTimedReleaseNotification(timedTask({ releace_time: "soon" }), now, LEAD_MS, "zh-CN");
    expect(broken).toBeNull();
  });

  it("treats the boundary as inside the window exclusively", () => {
    const exactlyAtLead = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: "2026-10-26 10:05:00" }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(exactlyAtLead).not.toBeNull();

    const pastLead = getUpcomingTimedReleaseNotification(
      timedTask({ releace_time: "2026-10-26 10:05:00.001" }),
      now,
      LEAD_MS,
      "zh-CN",
    );
    expect(pastLead).toBeNull();
  });
});

describe("getLiveTimedReleaseAt", () => {
  it("returns the release time of a live timed-release task", () => {
    expect(getLiveTimedReleaseAt(timedTask({ releace_time: "2026-10-26 10:00:00" }))).toBe(Date.parse("2026-10-26T10:00:00"));
  });

  it("returns null for other release conditions, ended tasks and missing times", () => {
    expect(getLiveTimedReleaseAt(timedTask({ releace_conditions: 1, releace_time: "2026-10-26 10:00:00" }))).toBeNull();
    expect(getLiveTimedReleaseAt(timedTask({ status: 4, releace_time: "2026-10-26 10:00:00" }))).toBeNull();
    expect(getLiveTimedReleaseAt(timedTask({ releace_time: null }))).toBeNull();
  });
});

describe("formatReleaseCountdown", () => {
  it("rounds the time left down to the minute in both languages", () => {
    expect(formatReleaseCountdown(40 * 60_000 + 30_000, "zh-CN")).toBe("40 分钟后释放");
    expect(formatReleaseCountdown((5 * 60 + 12) * 60_000, "en-US")).toBe("Releases in 5 hr 12 min");
  });

  it("names the last minute and an overdue release instead of showing zero", () => {
    expect(formatReleaseCountdown(20_000, "zh-CN")).toBe("1 分钟内释放");
    expect(formatReleaseCountdown(0, "en-US")).toBe("Release due");
    expect(formatReleaseCountdown(-5_000, "zh-CN")).toBe("已到释放时间");
  });
});
