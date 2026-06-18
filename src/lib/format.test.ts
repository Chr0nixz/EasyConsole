import { describe, expect, it } from "vitest";

import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatSecondsDuration, formatTaskDefaultName, getTaskNodeName } from "./format";

describe("format helpers", () => {
  it("formats default task names as compact local time", () => {
    expect(formatTaskDefaultName(new Date(2026, 4, 23, 0, 58, 32))).toBe("202605230058");
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
});
