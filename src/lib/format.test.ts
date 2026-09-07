import { describe, expect, it } from "vitest";

import {
  addHours,
  formatDateTimeForApi,
  formatDateTimeLocalInput,
  formatExperimentTimedTaskName,
  formatHours,
  formatRelativeUpdatedAt,
  formatSecondsDuration,
  formatTaskDefaultName,
  getTaskNodeName,
  getTaskReleaseCondition,
} from "./format";

describe("format helpers", () => {
  it("formats default task names as compact local time", () => {
    expect(formatTaskDefaultName(new Date(2026, 4, 23, 0, 58, 32))).toBe("202605230058");
  });

  it("formats experiment-timed instance names without mutating the experiment id", () => {
    expect(formatExperimentTimedTaskName("exp-run", new Date(2026, 4, 23, 0, 58, 32))).toBe("exp-run_202605230058");
    expect(formatExperimentTimedTaskName("  ", new Date(2026, 4, 23, 0, 58, 32))).toBe("");
  });

  it("normalizes datetime-local values for API payloads", () => {
    expect(formatDateTimeForApi("2026-05-23T01:05")).toBe("2026-05-23 01:05:00");
    expect(formatDateTimeForApi("2026-05-23T01:09:18")).toBe("2026-05-23 01:09:18");
  });

  it("formats datetime-local input values with seconds", () => {
    expect(formatDateTimeLocalInput(new Date(2026, 4, 24, 1, 9, 18))).toBe("2026-05-24T01:09:18");
  });

  it("adds fractional hours for release-time defaults", () => {
    expect(formatDateTimeLocalInput(addHours(new Date(2026, 4, 23, 1, 9, 18), 12))).toBe("2026-05-23T13:09:18");
  });

  it("formats task use_time values as seconds-based durations", () => {
    expect(formatSecondsDuration(90)).toBe("1 分钟");
    expect(formatSecondsDuration(3660)).toBe("1 小时 1 分钟");
  });

  // use_time is hours from /instance/statics, seconds from /instance/task; the wrong formatter reads as "0 分钟".
  it("formats task use_time values as fractional hours", () => {
    expect(formatHours(11.6021)).toBe("11.6 小时");
    expect(formatHours(11.6021, "en-US")).toBe("11.6 hr");
    expect(formatHours(0.2938)).toBe("18 分钟");
    expect(formatHours(0.2938, "en-US")).toBe("18 min");
    expect(formatHours(23.9978)).toBe("24.0 小时");
    expect(formatHours(undefined)).toBe("-");
  });

  it("formats relative update times across every tier in both locales", () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeUpdatedAt(now - 2_000, now)).toBe("刚刚");
    expect(formatRelativeUpdatedAt(now - 2_000, now, "en-US")).toBe("Just now");
    expect(formatRelativeUpdatedAt(now - 30_000, now)).toBe("30 秒前");
    expect(formatRelativeUpdatedAt(now - 30_000, now, "en-US")).toBe("30s ago");
    expect(formatRelativeUpdatedAt(now - 300_000, now)).toBe("5 分钟前");
    expect(formatRelativeUpdatedAt(now - 300_000, now, "en-US")).toBe("5m ago");
    expect(formatRelativeUpdatedAt(now - 7_200_000, now)).toBe("2 小时前");
    expect(formatRelativeUpdatedAt(now - 7_200_000, now, "en-US")).toBe("2h ago");
    expect(formatRelativeUpdatedAt(now - 5 * 86_400_000, now)).toBe("5 天前");
    expect(formatRelativeUpdatedAt(now - 5 * 86_400_000, now, "en-US")).toBe("5d ago");
    // A server clock ahead of the client must not render as a negative age.
    expect(formatRelativeUpdatedAt(now + 60_000, now)).toBe("刚刚");
  });

  it("reads task node names from node.name with node_name fallback", () => {
    expect(getTaskNodeName({ node: { name: "gpu-node-1" } })).toBe("gpu-node-1");
    expect(getTaskNodeName({ node_name: "legacy-node" })).toBe("legacy-node");
    expect(getTaskNodeName({ node: { name: "primary" }, node_name: "legacy" })).toBe("primary");
    expect(getTaskNodeName({
      id: 46097,
      node: {
        name: "gpu229-worker5",
        node_type: "node",
        ip: "116.172.93.229",
        status: true,
        id: 9,
      },
    })).toBe("gpu229-worker5");
    expect(getTaskNodeName({})).toBe("");
  });

  it("reads release condition from the backend releace_conditions spelling first", () => {
    expect(getTaskReleaseCondition({ releace_conditions: 2 })).toBe(2);
    expect(getTaskReleaseCondition({ release_condition: 1 })).toBe(1);
    expect(getTaskReleaseCondition({ releace_conditions: 3, release_condition: 1 })).toBe(3);
    expect(getTaskReleaseCondition({ releace_conditions: "2" })).toBe(2);
    expect(getTaskReleaseCondition({})).toBeUndefined();
  });
});
