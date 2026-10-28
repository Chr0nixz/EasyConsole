import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listBatchOperations } from "../../lib/change-list";
import { I18nProvider } from "../../lib/i18n";
import { ApiError } from "../../lib/types";
import type { PreviewItem } from "./BatchResultDialog";
import { useBatchOperation } from "./use-batch-operation";
import { verifyUnknownCreateItems } from "./verify-unknown-items";

const { memoryStorage, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const memoryStorage = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    remove: async (key: string) => {
      store.delete(key);
    },
  };
  return { memoryStorage, store };
});

vi.mock("../../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/runtime")>();
  return { ...actual, browserRuntime: { ...actual.browserRuntime, storage: memoryStorage } };
});

const items: PreviewItem[] = [
  { key: "1", name: "alpha-01" },
  { key: "2", name: "alpha-02" },
  { key: "3", name: "alpha-03" },
];

function renderOperation() {
  return renderHook(() => useBatchOperation(), { wrapper: I18nProvider });
}

describe("useBatchOperation", () => {
  beforeEach(() => {
    store.clear();
  });

  it("keeps going after a failed item, reports live progress, and lands the change-list record", async () => {
    const { result } = renderOperation();
    const run = vi.fn().mockResolvedValueOnce({ id: "11" }).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ id: "33" });
    const settled = vi.fn();

    await act(async () => {
      void result.current.start({ action: "create", items, run, onSettled: settled });
    });
    // The first item has settled while the rest are still running.
    await waitFor(() => expect(result.current.state?.result.outcomes).toHaveLength(2));
    expect(result.current.state?.pending).toBe(true);
    expect(result.current.state?.result.outcomes[0]).toMatchObject({ status: "succeeded" });
    expect(result.current.state?.result.outcomes[1]).toMatchObject({ status: "failed", error: "boom" });

    await waitFor(() => expect(result.current.state?.pending).toBe(false));
    expect(run).toHaveBeenCalledTimes(3);
    const finalState = result.current.state!;
    expect(finalState.result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0, unknown: 0 });
    expect(settled).toHaveBeenCalledWith(finalState.result, finalState.record);

    const records = await listBatchOperations(memoryStorage);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "create", trigger: "ui" });
    expect(records[0].items[1]).toMatchObject({ key: "2", status: "failed", error: "boom" });
    expect(records[0].items[0].remoteTaskId).toBe("11");
    expect(records[0].summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0, unknown: 0 });
    expect(result.current.state?.records).toHaveLength(1);
  });

  it("retries only the failed subset, merges outcomes back, and links the retry record", async () => {
    const { result } = renderOperation();
    const firstRun = vi.fn().mockResolvedValueOnce({ id: "11" }).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ id: "33" });
    await act(async () => {
      await result.current.start({ action: "create", items, run: firstRun });
    });
    const firstRecordId = result.current.state?.record?.id;

    // Retry re-runs through the original run function, only for the failed item.
    firstRun.mockResolvedValueOnce({ id: "22" });
    const retried = await act(async () => result.current.retryFailed());
    expect(firstRun).toHaveBeenCalledTimes(4);
    expect(firstRun.mock.calls[3][0]).toMatchObject({ key: "2", name: "alpha-02" });

    expect(result.current.state?.result.summary).toEqual({ total: 3, succeeded: 3, failed: 0, skipped: 0, unknown: 0 });
    expect(result.current.state?.result.outcomes.every((outcome) => outcome.status === "succeeded")).toBe(true);

    const records = await listBatchOperations(memoryStorage);
    expect(records).toHaveLength(2);
    expect(records[0].items).toHaveLength(1);
    expect(records[0].items[0]).toMatchObject({ key: "2", status: "succeeded", remoteTaskId: "22" });
    expect(records[0].retryOf).toBe(firstRecordId);
    expect(retried?.record.retryOf).toBe(firstRecordId);
    expect(result.current.state?.records).toEqual([records[1], records[0]]);
  });

  it("refuses a retry while the run is pending or nothing failed, and clear() resets the state", async () => {
    const { result } = renderOperation();
    const run = vi.fn().mockResolvedValue({});
    await act(async () => {
      await result.current.start({ action: "delete", items: items.slice(0, 1), run, remoteTaskIdFromItem: (item) => item.key });
    });
    expect(result.current.state?.record?.items[0].remoteTaskId).toBe("1");

    const retriedNothing = await act(async () => result.current.retryFailed());
    expect(retriedNothing).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);

    act(() => result.current.clear());
    expect(result.current.state).toBeNull();
  });

  it("does not get stuck pending when the change-list write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderOperation();
    const run = vi.fn().mockResolvedValue({});
    const failingSet = vi.spyOn(memoryStorage, "set").mockRejectedValueOnce(new Error("quota exceeded"));

    await act(async () => {
      await result.current.start({ action: "create", items: items.slice(0, 1), run });
    });

    expect(result.current.state?.pending).toBe(false);
    expect(result.current.state?.record).toBeTruthy();
    expect(result.current.state?.result.summary.succeeded).toBe(1);
    expect(failingSet).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    failingSet.mockRestore();
  });

  it("records the retry start time before the re-run, not its finish", async () => {
    const { result } = renderOperation();
    const run = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {};
      });
    await act(async () => {
      await result.current.start({ action: "create", items: items.slice(0, 2), run });
    });

    const retried = await act(async () => result.current.retryFailed());
    const duration = Date.parse(retried!.record.finishedAt ?? "") - Date.parse(retried!.record.startedAt);
    expect(duration).toBeGreaterThanOrEqual(30);
  });

  it("resolves unknown items into terminal outcomes and revises the stored record", async () => {
    const { result } = renderOperation();
    const networkFailure = new ApiError("fetch dropped", { kind: "network" });
    const run = vi.fn().mockResolvedValueOnce({ id: "11" }).mockRejectedValueOnce(networkFailure);
    await act(async () => {
      await result.current.start({ action: "create", items: items.slice(0, 2), run });
    });
    expect(result.current.state?.result.summary).toEqual({ total: 2, succeeded: 1, failed: 0, skipped: 0, unknown: 1 });

    await act(async () => {
      const next = await result.current.resolveUnknown([{ key: "2", status: "confirmed-created", remoteTaskId: "task-22" }]);
      expect(next?.summary).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: 0, unknown: 0 });
    });
    expect(result.current.state?.result.outcomes[1]).toMatchObject({ status: "succeeded" });

    // Flip a fresh unknown to not-created: it becomes retryable (failed).
    const runTwo = vi.fn().mockRejectedValueOnce(networkFailure);
    await act(async () => {
      await result.current.start({ action: "create", items: items.slice(0, 1), run: runTwo });
    });
    await act(async () => {
      await result.current.resolveUnknown([{ key: "1", status: "confirmed-not-created" }]);
    });
    expect(result.current.state?.result.outcomes[0]).toMatchObject({ status: "failed" });
    expect(result.current.state?.result.summary.unknown).toBe(0);

    const records = await listBatchOperations(memoryStorage);
    expect(records.every((record) => record.summary.unknown === 0)).toBe(true);
    expect(records[0].items[0]).toMatchObject({ key: "1", status: "failed" });
    expect(records[1].items[1]).toMatchObject({ key: "2", status: "succeeded", remoteTaskId: "task-22" });
  });

  it.each(["scan-limit", "missing-timestamp"])("does not resubmit a create after inconclusive %s verification", async (scenario) => {
    const { result } = renderOperation();
    const run = vi.fn()
      .mockRejectedValueOnce(new ApiError("response lost after remote create", { kind: "network" }))
      .mockResolvedValueOnce({ id: "duplicate-instance" });
    await act(async () => {
      await result.current.start({ action: "create", items: items.slice(0, 1), run });
    });

    const state = result.current.state!;
    const existingTask = { id: "already-created", name: items[0].name };
    const resolutions = await verifyUnknownCreateItems(state.result.outcomes, {
      startedAt: state.record!.startedAt,
      listTasks: async ({ page }) => ({
        items: scenario === "missing-timestamp"
          ? [existingTask]
          : page === 4
            ? [{ ...existingTask, create_time: state.record!.startedAt }]
            : Array.from({ length: 100 }, (_, index) => ({ id: `${page}-${index}`, name: `other-${page}-${index}` })),
      }),
    });

    await act(async () => {
      await result.current.resolveUnknown(resolutions);
    });
    const retry = await act(async () => result.current.retryFailed());

    expect(retry).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.state?.result.summary).toMatchObject({ failed: 0, unknown: 1 });
    const records = await listBatchOperations(memoryStorage);
    expect(records).toHaveLength(1);
    expect(records[0].items[0]).toMatchObject({ status: "unknown" });
  });
});
