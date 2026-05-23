import { describe, expect, it } from "vitest";

import { createUploadQueueItems, summarizeUploadQueue } from "./upload-queue";

function file(name: string, size: number) {
  return new File([new Uint8Array(size)], name, { lastModified: 1 });
}

describe("upload queue", () => {
  it("builds queue items with remote directories and skips empty files", () => {
    const nested = file("run.py", 3);
    Object.defineProperty(nested, "webkitRelativePath", { value: "job/scripts/run.py" });

    const items = createUploadQueueItems([nested, file("empty.txt", 0)], "/alice");

    expect(items[0]).toMatchObject({
      relativePath: "job/scripts/run.py",
      remoteDirectory: "/alice/job/scripts",
      status: "queued",
      progress: 0,
    });
    expect(items[1]).toMatchObject({
      relativePath: "empty.txt",
      remoteDirectory: "/alice",
      status: "skipped",
      progress: 100,
      skipReason: "不支持上传空文件",
    });
  });

  it("summarizes completed, failed, skipped and active queue state", () => {
    const items = createUploadQueueItems([file("a.txt", 1), file("b.txt", 1), file("empty.txt", 0)], "/");
    const next = [
      { ...items[0], status: "done" as const, progress: 100 },
      { ...items[1], status: "failed" as const, progress: 50 },
      items[2],
    ];

    expect(summarizeUploadQueue(next)).toMatchObject({
      total: 3,
      uploadable: 2,
      completed: 1,
      failed: 1,
      skipped: 1,
      percent: 75,
      active: false,
    });
  });
});
