import { describe, expect, it } from "vitest";

import {
  getStorageBreadcrumbs,
  getStorageEntryModified,
  getStorageEntrySize,
  getStorageParentPath,
  isStorageDirectory,
  joinStoragePath,
  normalizeStoragePath,
} from "./remote-storage";

describe("remote storage path helpers", () => {
  it("normalizes remote paths", () => {
    expect(normalizeStoragePath("")).toBe("/");
    expect(normalizeStoragePath("alice/work")).toBe("/alice/work");
    expect(normalizeStoragePath("\\alice\\work//runs")).toBe("/alice/work/runs");
  });

  it("joins and gets parent paths", () => {
    expect(joinStoragePath("/", "data")).toBe("/data");
    expect(joinStoragePath("/alice/", "run.py")).toBe("/alice/run.py");
    expect(getStorageParentPath("/alice/run.py")).toBe("/alice");
    expect(getStorageParentPath("/alice")).toBe("/");
  });

  it("builds breadcrumbs", () => {
    expect(getStorageBreadcrumbs("/alice/jobs")).toEqual([
      { label: "根目录", path: "/" },
      { label: "alice", path: "/alice" },
      { label: "jobs", path: "/alice/jobs" },
    ]);
  });

  it("recognizes backend directory variants", () => {
    expect(isStorageDirectory({ name: "data", isdir: true })).toBe(true);
    expect(isStorageDirectory({ name: "data", type: "folder" })).toBe(true);
    expect(isStorageDirectory({ name: "xutian", size: 0 }, "/")).toBe(true);
    expect(isStorageDirectory({ name: "README", size: 0 }, "/xutian")).toBe(false);
    expect(isStorageDirectory({ name: "data", type: "file", size: 0 }, "/")).toBe(false);
  });

  it("reads backend size and modified field variants", () => {
    expect(getStorageEntrySize({ name: "a", file_size: "1024" })).toBe(1024);
    expect(getStorageEntrySize({ name: "a", bytes: 2048 })).toBe(2048);
    expect(getStorageEntrySize({ name: "a", fileSize: "1,024" })).toBe(1024);
    expect(getStorageEntrySize({ name: "a", total_size: "1.5 KB" })).toBe(1536);
    expect(getStorageEntrySize({ name: "a", folder_size: "2 MB" })).toBe(2 * 1024 * 1024);
    expect(getStorageEntrySize({ name: "a" })).toBeNull();
    expect(getStorageEntryModified({ name: "a", update_time: "2026-05-23 12:00:00" })).toBe("2026-05-23 12:00:00");
    expect(getStorageEntryModified({ name: "a" })).toBe("-");
  });
});
