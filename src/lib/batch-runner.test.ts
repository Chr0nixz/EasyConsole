import { afterEach, describe, expect, it, vi } from "vitest";

import { retryFailedBatchItems, runBatch, type BatchItemOutcome } from "./batch-runner";
import { ApiError } from "./types";

afterEach(() => {
  vi.useRealTimers();
});

function failingFor(target: string) {
  return async (item: string) => {
    if (item === target) throw new Error(`boom:${item}`);
    return `ok:${item}`;
  };
}

function networkError(message = "Network request failed") {
  return new ApiError(message, { kind: "network" });
}

describe("runBatch", () => {
  it("continues after a failing item by default", async () => {
    const ran: string[] = [];
    const result = await runBatch(["a", "b", "c"], {
      run: async (item) => {
        ran.push(item);
        if (item === "a") throw new Error("release rejected");
        return item.toUpperCase();
      },
    });

    expect(ran).toEqual(["a", "b", "c"]);
    expect(result.outcomes).toEqual([
      { item: "a", status: "failed", error: "release rejected" },
      { item: "b", status: "succeeded", result: "B" },
      { item: "c", status: "succeeded", result: "C" },
    ]);
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0, unknown: 0 });
  });

  it("resolves instead of rejecting when every item fails", async () => {
    const result = await runBatch([1, 2, 3], {
      run: async (item) => {
        throw new Error(`nope ${item}`);
      },
    });

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["failed", "failed", "failed"]);
    expect(result.outcomes.map((outcome) => outcome.error)).toEqual(["nope 1", "nope 2", "nope 3"]);
    expect(result.summary).toEqual({ total: 3, succeeded: 0, failed: 3, skipped: 0, unknown: 0 });
  });

  it("marks non-Error rejections with a stringified error", async () => {
    const result = await runBatch(["a"], {
      run: async () => {
        throw "plain failure";
      },
    });
    expect(result.outcomes[0]).toMatchObject({ status: "failed", error: "plain failure" });
  });

  it("marks items that never started as skipped after an abort", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const result = await runBatch(["a", "b", "c"], {
      signal: controller.signal,
      run: async (item) => {
        ran.push(item);
        return item;
      },
      onProgress: (_outcomes, current) => {
        if (current.item === "a") controller.abort();
      },
    });

    expect(ran).toEqual(["a"]);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["succeeded", "skipped", "skipped"]);
    expect(result.summary).toEqual({ total: 3, succeeded: 1, failed: 0, skipped: 2, unknown: 0 });
  });

  it("skips everything when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async (item: string) => item);

    const result = await runBatch(["a", "b"], { signal: controller.signal, run });

    expect(run).not.toHaveBeenCalled();
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped"]);
  });

  it("marks the remaining items skipped when continueOnError is false", async () => {
    const ran: string[] = [];
    const result = await runBatch(["a", "b", "c"], {
      continueOnError: false,
      run: async (item) => {
        ran.push(item);
        if (item === "b") throw new Error("stop here");
        return item;
      },
    });

    expect(ran).toEqual(["a", "b"]);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(result.summary).toEqual({ total: 3, succeeded: 1, failed: 1, skipped: 1, unknown: 0 });
  });

  it("does not wait before the first item and applies the delay between items", async () => {
    vi.useFakeTimers();
    const events: string[] = [];

    const promise = runBatch(["a", "b"], {
      delayMs: 100,
      run: async (item) => {
        events.push(`run:${item}`);
        return item;
      },
      onProgress: (_outcomes, current) => events.push(`done:${current.item}`),
    });

    // The first item runs without any timer advance.
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["run:a", "done:a"]);

    // The second item only runs after the inter-item delay elapses.
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toEqual(["run:a", "done:a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["run:a", "done:a", "run:b", "done:b"]);

    await expect(promise).resolves.toMatchObject({ summary: { total: 2, succeeded: 2 } });
  });

  it("runs without delays when delayMs is zero", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const promise = runBatch(["a", "b", "c"], {
      delayMs: 0,
      run: async (item) => {
        events.push(item);
        return item;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(events).toEqual(["a", "b", "c"]);
  });

  it("calls onProgress once per item with the accumulated outcomes", async () => {
    const snapshots: { count: number; current: BatchItemOutcome<string, string> }[] = [];
    const result = await runBatch(["a", "b"], {
      delayMs: 0,
      run: failingFor("b"),
      onProgress: (outcomes, current) => snapshots.push({ count: outcomes.length, current }),
    });

    expect(snapshots.map((snapshot) => snapshot.current.status)).toEqual(["succeeded", "failed"]);
    expect(snapshots.map((snapshot) => snapshot.count)).toEqual([1, 2]);
    expect(snapshots[1]!.current).toMatchObject({ item: "b", status: "failed", error: "boom:b" });
    expect(result.summary).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: 0, unknown: 0 });
  });

  it("passes each item's index to run", async () => {
    const indices: number[] = [];
    await runBatch(["x", "y", "z"], {
      delayMs: 0,
      run: async (_item, index) => {
        indices.push(index);
        return index;
      },
    });
    expect(indices).toEqual([0, 1, 2]);
  });

  it("marks network-level failures as unknown instead of failed", async () => {
    const result = await runBatch(["a", "b"], {
      delayMs: 0,
      run: async (item) => {
        if (item === "a") throw networkError("fetch dropped");
        return item;
      },
    });

    expect(result.outcomes).toEqual([
      { item: "a", status: "unknown", error: "fetch dropped" },
      { item: "b", status: "succeeded", result: "b" },
    ]);
    expect(result.summary).toEqual({ total: 2, succeeded: 1, failed: 0, skipped: 0, unknown: 1 });
  });

  it("keeps abort-style failures as failed", async () => {
    const result = await runBatch(["a"], {
      delayMs: 0,
      run: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });

    expect(result.outcomes[0]).toMatchObject({ status: "failed" });
  });
});

describe("retryFailedBatchItems", () => {
  it("retries only the failed items in their original order", async () => {
    const previous = await runBatch(["a", "b", "c"], { delayMs: 0, run: failingFor("b") });
    // Make the third item skipped as well to prove skipped items are not retried.
    const controller = new AbortController();
    controller.abort();
    const withSkipped = await runBatch(["a", "b", "c"], {
      delayMs: 0,
      signal: controller.signal,
      run: failingFor("b"),
    });

    const ran: string[] = [];
    const retried = await retryFailedBatchItems(previous, {
      delayMs: 0,
      run: async (item) => {
        ran.push(item);
        return item;
      },
    });

    expect(ran).toEqual(["b"]);
    expect(retried.outcomes).toEqual([{ item: "b", status: "succeeded", result: "b" }]);
    expect(retried.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0, unknown: 0 });
    expect(withSkipped.outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped", "skipped"]);
  });

  it("reports a still-failing retry without rejecting", async () => {
    const previous = await runBatch(["a", "b"], { delayMs: 0, run: failingFor("b") });
    const retried = await retryFailedBatchItems(previous, {
      delayMs: 0,
      run: async () => {
        throw new Error("still broken");
      },
    });

    expect(retried.outcomes).toEqual([{ item: "b", status: "failed", error: "still broken" }]);
    expect(retried.summary).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 0, unknown: 0 });
  });

  it("never retries unknown items", async () => {
    const previous = await runBatch(["a", "b"], {
      delayMs: 0,
      run: async (item) => {
        if (item === "a") throw networkError();
        throw new Error("definite rejection");
      },
    });

    const ran: string[] = [];
    const retried = await retryFailedBatchItems(previous, {
      delayMs: 0,
      run: async (item) => {
        ran.push(item);
        return item;
      },
    });

    expect(ran).toEqual(["b"]);
    expect(retried.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0, unknown: 0 });
  });
});
