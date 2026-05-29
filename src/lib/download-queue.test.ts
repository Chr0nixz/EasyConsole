import { describe, expect, it } from "vitest";

import { summarizeDownloadQueue } from "./download-queue";
import type { DownloadQueueItem } from "./types";

function item(partial: Partial<DownloadQueueItem>): DownloadQueueItem {
  return {
    id: partial.id ?? "download-1",
    source: partial.source ?? "storage",
    sourceLabel: partial.sourceLabel ?? "Storage",
    filename: partial.filename ?? "file.zip",
    targetName: partial.targetName ?? "/file.zip",
    status: partial.status ?? "queued",
    progress: partial.progress ?? 0,
    loaded: partial.loaded ?? 0,
    total: partial.total,
    createdAt: partial.createdAt ?? "2026-05-25T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-05-25T00:00:00.000Z",
  };
}

describe("download queue", () => {
  it("summarizes active, completed, failed and cancelled items", () => {
    const summary = summarizeDownloadQueue([
      item({ id: "1", status: "done", progress: 100, loaded: 10, total: 10 }),
      item({ id: "2", status: "downloading", progress: 50, loaded: 5, total: 10 }),
      item({ id: "3", status: "failed", progress: 25 }),
      item({ id: "4", status: "cancelled" }),
    ]);

    expect(summary).toMatchObject({
      total: 4,
      active: 1,
      completed: 1,
      failed: 1,
      cancelled: 1,
      percent: 75,
    });
  });

  it("falls back to average progress when total size is unknown", () => {
    expect(summarizeDownloadQueue([item({ progress: 20 }), item({ progress: 60 })]).percent).toBe(40);
  });
});
