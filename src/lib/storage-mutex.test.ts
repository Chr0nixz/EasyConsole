import { describe, expect, it } from "vitest";

import { appendRunLog, RUN_LOGS_STORAGE_KEY } from "./run-logs";
import { loadScheduledTasks, mutateScheduledTasks, SCHEDULED_TASKS_STORAGE_KEY } from "./scheduled-tasks";
import { updateStorageValue, withStorageLock } from "./storage-mutex";
import type { RuntimeStorage } from "./types";

function memoryStorage(initial: Record<string, string> = {}): RuntimeStorage {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

describe("storage-mutex", () => {
  it("serializes concurrent updates for the same key", async () => {
    const storage = memoryStorage();
    await Promise.all([
      updateStorageValue(storage, "counter", async (raw) => String(Number(raw ?? "0") + 1)),
      updateStorageValue(storage, "counter", async (raw) => String(Number(raw ?? "0") + 1)),
      updateStorageValue(storage, "counter", async (raw) => String(Number(raw ?? "0") + 1)),
    ]);
    expect(await storage.get("counter")).toBe("3");
  });

  it("keeps concurrent appendRunLog entries", async () => {
    const storage = memoryStorage();
    await Promise.all([
      appendRunLog(storage, {
        source: "task",
        level: "info",
        channel: "web",
        action: "a",
        result: "success",
        title: "one",
      }),
      appendRunLog(storage, {
        source: "task",
        level: "info",
        channel: "web",
        action: "b",
        result: "success",
        title: "two",
      }),
    ]);
    const raw = await storage.get(RUN_LOGS_STORAGE_KEY);
    const parsed = JSON.parse(raw ?? "[]") as Array<{ title: string }>;
    expect(parsed.map((item) => item.title).sort()).toEqual(["one", "two"]);
  });

  it("returns empty scheduled tasks for corrupt JSON", async () => {
    const storage = memoryStorage({ [SCHEDULED_TASKS_STORAGE_KEY]: "{not-json" });
    await expect(loadScheduledTasks(storage)).resolves.toEqual([]);
  });

  it("mutates scheduled tasks under a lock", async () => {
    const storage = memoryStorage({ [SCHEDULED_TASKS_STORAGE_KEY]: "[]" });
    await mutateScheduledTasks(storage, () => [
      {
        id: "1",
        name: "once",
        scheduleTime: "2099-01-01T00:00",
        status: "pending",
        payload: { name: "once" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await expect(loadScheduledTasks(storage)).resolves.toHaveLength(1);
  });

  it("runs withStorageLock callbacks sequentially", async () => {
    const order: number[] = [];
    await Promise.all([
      withStorageLock("k", async () => {
        order.push(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(2);
      }),
      withStorageLock("k", async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
