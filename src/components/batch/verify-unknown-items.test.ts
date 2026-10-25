import { describe, expect, it, vi } from "vitest";

import type { BatchItemOutcome } from "../../lib/batch-runner";
import type { Task } from "../../lib/types";
import { verifyUnknownCreateItems } from "./verify-unknown-items";
import type { PreviewItem } from "./BatchResultDialog";

const STARTED_AT = "2026-10-25T10:00:00.000Z";

function item(key: string, name: string): PreviewItem {
  return { key, name };
}

function unknownOutcome(key: string, name: string): BatchItemOutcome<PreviewItem> {
  return { item: item(key, name), status: "unknown", error: "fetch dropped" };
}

function task(id: number, name: string, create_time?: string): Task {
  return { id, task_id: `task-${id}`, name, ...(create_time ? { create_time } : {}) } as Task;
}

describe("verifyUnknownCreateItems", () => {
  it("confirms created when exactly one in-window name match exists", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({
        items: [
          task(1, "train-a", "2026-10-25T10:00:05Z"),
          task(2, "other", "2026-10-25T09:59:00Z"),
        ],
      }),
    });

    expect(resolutions).toEqual([{ key: "0", status: "confirmed-created", remoteTaskId: "task-1" }]);
  });

  it("confirms not created when nothing matches the name", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-b")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({ items: [task(1, "train-a", "2026-10-25T10:00:05Z")] }),
    });

    expect(resolutions).toEqual([{ key: "0", status: "confirmed-not-created" }]);
  });

  it("leaves ambiguous matches unknown for manual review", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({
        items: [
          task(1, "train-a", "2026-10-25T10:00:05Z"),
          task(2, "train-a-2", "2026-10-25T10:00:30Z"),
        ],
      }),
    });

    expect(resolutions).toEqual([]);
  });

  it("ignores same-named tasks created outside the batch window", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({ items: [task(1, "train-a", "2026-09-01T00:00:00Z")] }),
    });

    expect(resolutions).toEqual([{ key: "0", status: "confirmed-not-created" }]);
  });

  it("returns nothing when there are no unknown outcomes", async () => {
    const listTasks = vi.fn(async () => ({ items: [] as Task[] }));
    const resolutions = await verifyUnknownCreateItems(
      [{ item: item("0", "train-a"), status: "succeeded" }],
      { startedAt: STARTED_AT, listTasks },
    );

    expect(resolutions).toEqual([]);
    expect(listTasks).not.toHaveBeenCalled();
  });
});
