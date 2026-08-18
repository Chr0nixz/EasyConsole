import { describe, expect, it } from "vitest";

import { nextNotificationPollInterval, TASK_SNAPSHOT_POLL_INTERVAL, TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX } from "./task-snapshot-query";

describe("nextNotificationPollInterval", () => {
  it("returns foreground interval when visible", () => {
    expect(nextNotificationPollInterval(120_000, false)).toBe(TASK_SNAPSHOT_POLL_INTERVAL);
  });

  it("exponentially backs off while hidden up to the max", () => {
    const first = nextNotificationPollInterval(TASK_SNAPSHOT_POLL_INTERVAL, true);
    expect(first).toBeGreaterThanOrEqual(60_000);
    const capped = nextNotificationPollInterval(TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX, true);
    expect(capped).toBe(TASK_SNAPSHOT_POLL_INTERVAL_HIDDEN_MAX);
  });
});
