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

  it("refuses to decide anything without a batch start time to anchor the window", async () => {
    const listTasks = vi.fn(async () => ({ items: [task(1, "train-a", "2026-10-25T10:00:05Z")] }));
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], { listTasks });

    expect(resolutions).toEqual([]);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("scans follow-up pages before declaring a create as not created", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => task(index + 1, `filler-${index}`, "2026-09-01T00:00:00Z"));
    const pages = [
      { items: filler },
      { items: [task(101, "train-a", "2026-10-25T10:00:05Z")] },
    ];
    const requestedPages: number[] = [];
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async (query) => {
        requestedPages.push(query.page);
        return pages[query.page - 1] ?? { items: [] };
      },
    });

    expect(requestedPages).toEqual([1, 2]);
    expect(resolutions).toEqual([{ key: "0", status: "confirmed-created", remoteTaskId: "task-101" }]);
  });

  it("keeps a create unknown when the matching task is beyond the scan limit", async () => {
    const listTasks = vi.fn(async ({ page }: { page: number }) => ({
      items: page === 4
        ? [task(301, "train-a", "2026-10-25T10:00:05Z")]
        : Array.from({ length: 100 }, (_, index) => task(page * 100 + index, `filler-${page}-${index}`)),
    }));

    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks,
    });

    expect(listTasks.mock.calls.map(([query]) => query.page)).toEqual([1, 2, 3]);
    expect(resolutions).toEqual([]);
  });

  it("does not confirm a match before a truncated scan can rule out other candidates", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async ({ page }) => ({
        items: Array.from({ length: 100 }, (_, index) =>
          page === 1 && index === 0
            ? task(1, "train-a", "2026-10-25T10:00:05Z")
            : task(page * 100 + index, `filler-${page}-${index}`),
        ),
      }),
    });

    expect(resolutions).toEqual([]);
  });

  it("checks for a final page after a full page before confirming absence", async () => {
    const listTasks = vi.fn(async ({ page }: { page: number }) => ({
      items: page === 1 ? Array.from({ length: 100 }, (_, index) => task(index, `filler-${index}`)) : [],
    }));

    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks,
    });

    expect(listTasks.mock.calls.map(([query]) => query.page)).toEqual([1, 2]);
    expect(resolutions).toEqual([{ key: "0", status: "confirmed-not-created" }]);
  });

  it.each([undefined, "invalid-date"])("keeps a same-named task with timestamp %s unknown", async (timestamp) => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({ items: [task(1, "train-a", timestamp)] }),
    });

    expect(resolutions).toEqual([]);
  });

  it("does not confirm a dated match while another candidate has an unreadable timestamp", async () => {
    const resolutions = await verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks: async () => ({
        items: [task(1, "train-a", "2026-10-25T10:00:05Z"), task(2, "train-a-2")],
      }),
    });

    expect(resolutions).toEqual([]);
  });

  it("resolves other batch items even when one item has an undated candidate", async () => {
    const resolutions = await verifyUnknownCreateItems(
      [unknownOutcome("0", "train-a"), unknownOutcome("1", "train-b"), unknownOutcome("2", "train-c")],
      {
        startedAt: STARTED_AT,
        listTasks: async () => ({
          items: [task(1, "train-a"), task(2, "train-b", "2026-10-25T10:00:05Z")],
        }),
      },
    );

    expect(resolutions).toEqual([
      { key: "1", status: "confirmed-created", remoteTaskId: "task-2" },
      { key: "2", status: "confirmed-not-created" },
    ]);
  });

  it("keeps results unknown when the reported total exceeds the scanned rows", async () => {
    const resolutions = await verifyUnknownCreateItems(
      [unknownOutcome("0", "train-a"), unknownOutcome("1", "train-b")],
      {
        startedAt: STARTED_AT,
        listTasks: async () => ({ items: [task(1, "train-a", "2026-10-25T10:00:05Z")], total: 200 }),
      },
    );

    expect(resolutions).toEqual([]);
  });

  it("does not return partial resolutions when a later page fails", async () => {
    const failure = new Error("task list unavailable");
    const listTasks = vi.fn()
      .mockResolvedValueOnce({ items: Array.from({ length: 100 }, (_, index) => task(index, `filler-${index}`)) })
      .mockRejectedValueOnce(failure);

    await expect(verifyUnknownCreateItems([unknownOutcome("0", "train-a")], {
      startedAt: STARTED_AT,
      listTasks,
    })).rejects.toBe(failure);
  });
});
