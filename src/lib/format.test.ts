import { describe, expect, it } from "vitest";

import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName } from "./format";

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
});
