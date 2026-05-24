import { describe, expect, it } from "vitest";

import type { RuntimeStorage } from "./types";
import {
  appendRunLog,
  clearRunLogs,
  filterRunLogs,
  loadRunLogs,
  parseRunLogs,
  pruneRunLogs,
  RUN_LOGS_STORAGE_KEY,
  sanitizeRunLogValue,
} from "./run-logs";

function memoryStorage(initial: Record<string, string> = {}): RuntimeStorage {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

describe("run logs", () => {
  it("returns an empty list for invalid stored JSON", () => {
    expect(parseRunLogs("{bad")).toEqual([]);
    expect(parseRunLogs(JSON.stringify({ ok: true }))).toEqual([]);
  });

  it("appends logs in newest-first order", async () => {
    const storage = memoryStorage();
    await appendRunLog(storage, {
      channel: "web",
      source: "task",
      action: "task.create",
      result: "success",
      level: "info",
      title: "created",
      createdAt: "2026-05-23T00:00:00.000Z",
    });
    await appendRunLog(storage, {
      channel: "cli",
      source: "storage",
      action: "storage.mkdir",
      result: "success",
      level: "info",
      title: "mkdir",
      createdAt: "2026-05-24T00:00:00.000Z",
    });

    expect((await loadRunLogs(storage)).map((item) => item.action)).toEqual(["storage.mkdir", "task.create"]);
  });

  it("prunes by retention and limit", () => {
    const now = () => new Date("2026-05-24T00:00:00.000Z");
    const items = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      channel: "web" as const,
      source: "task" as const,
      action: `action.${index}`,
      result: "success" as const,
      level: "info" as const,
      title: `item ${index}`,
      createdAt: new Date(Date.UTC(2026, 4, 24 - index * 10)).toISOString(),
    }));

    expect(pruneRunLogs(items, { now, retentionDays: 30, limit: 2 }).map((item) => item.action)).toEqual([
      "action.0",
      "action.1",
    ]);
  });

  it("redacts sensitive metadata fields", () => {
    expect(
      sanitizeRunLogValue({
        token: "abc",
        nested: { Authorization: "Bearer abc", safe: "value" },
      }),
    ).toEqual({
      token: "[redacted]",
      nested: { Authorization: "[redacted]", safe: "value" },
    });
  });

  it("filters logs by source, channel, result, and keyword", () => {
    const logs = parseRunLogs(
      JSON.stringify([
        {
          id: "1",
          createdAt: "2026-05-24T00:00:00.000Z",
          channel: "cli",
          source: "task",
          action: "task.release",
          result: "failure",
          level: "error",
          title: "release failed",
          targetName: "demo",
        },
        {
          id: "2",
          createdAt: "2026-05-23T00:00:00.000Z",
          channel: "web",
          source: "storage",
          action: "storage.mkdir",
          result: "success",
          level: "info",
          title: "created folder",
        },
      ]),
    );

    expect(filterRunLogs(logs, { source: "task", channel: "cli", result: "failure", keyword: "demo" })).toHaveLength(1);
    expect(filterRunLogs(logs, { keyword: "folder" })).toHaveLength(1);
  });

  it("clears stored logs", async () => {
    const storage = memoryStorage({ [RUN_LOGS_STORAGE_KEY]: "[]" });
    await appendRunLog(storage, {
      channel: "web",
      source: "task",
      action: "task.create",
      result: "success",
      level: "info",
      title: "created",
    });
    await clearRunLogs(storage);
    expect(await loadRunLogs(storage)).toEqual([]);
  });
});
