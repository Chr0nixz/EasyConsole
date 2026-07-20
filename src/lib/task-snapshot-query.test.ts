import { describe, expect, it, vi } from "vitest";

import { invalidateTaskQueries, TASK_SNAPSHOT_QUERY_KEY } from "./task-snapshot-query";

describe("task-snapshot-query", () => {
  it("invalidates both paginated tasks and the shared snapshot", () => {
    const invalidateQueries = vi.fn();
    invalidateTaskQueries({ invalidateQueries } as never);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["tasks"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: TASK_SNAPSHOT_QUERY_KEY });
  });
});
