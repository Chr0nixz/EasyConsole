import { describe, expect, it } from "vitest";

import { CREATE_MATCH_WINDOW_MS, createTimeProximity, MAX_ZONE_SKEW_MS, parseTaskCreatedAt } from "./create-time-match";

describe("parseTaskCreatedAt", () => {
  it("tells creation times that name a zone from the backend's bare wall clock", () => {
    expect(parseTaskCreatedAt({ create_time: "2026-10-25 10:00:05" })).toMatchObject({ zoned: false });
    expect(parseTaskCreatedAt({ create_time: "2026-10-25T10:00:05" })).toMatchObject({ zoned: false });
    expect(parseTaskCreatedAt({ create_time: "2026-10-25T10:00:05Z" })).toMatchObject({ zoned: true });
    expect(parseTaskCreatedAt({ create_time: "2026-10-25T10:00:05+08:00" })).toMatchObject({ zoned: true });
    expect(parseTaskCreatedAt({ created_at: "2026-10-25T10:00:05-0800" })).toMatchObject({ zoned: true });
  });

  it("returns null for a missing or unreadable creation time", () => {
    expect(parseTaskCreatedAt({})).toBeNull();
    expect(parseTaskCreatedAt({ create_time: "  " })).toBeNull();
    expect(parseTaskCreatedAt({ create_time: "yesterday" })).toBeNull();
  });
});

describe("createTimeProximity", () => {
  const start = Date.parse("2026-10-25T10:00:00Z");

  it("rules out a zoned time just outside the window", () => {
    expect(createTimeProximity({ at: start + CREATE_MATCH_WINDOW_MS, zoned: true }, start)).toBe("inside");
    expect(createTimeProximity({ at: start + CREATE_MATCH_WINDOW_MS + 1, zoned: true }, start)).toBe("outside");
  });

  it("keeps a bare wall-clock time possible across any zone gap, and no further", () => {
    expect(createTimeProximity({ at: start + 8 * 3_600_000, zoned: false }, start)).toBe("possible");
    expect(createTimeProximity({ at: start - CREATE_MATCH_WINDOW_MS - MAX_ZONE_SKEW_MS, zoned: false }, start)).toBe("possible");
    expect(createTimeProximity({ at: start - CREATE_MATCH_WINDOW_MS - MAX_ZONE_SKEW_MS - 1, zoned: false }, start)).toBe("outside");
  });
});
