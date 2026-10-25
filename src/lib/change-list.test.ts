import { describe, expect, it } from "vitest";

import {
  activeBatchOperationAccount,
  appendBatchOperation,
  applyBatchItemResolutions,
  BATCH_OPERATIONS_STORAGE_KEY,
  createBatchOperationRecord,
  listBatchOperations,
  parseBatchOperations,
  pruneBatchOperations,
  updateBatchOperation,
  type BatchOperationItem,
  type BatchOperationRecord,
} from "./change-list";
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

// Records in these tests are backdated to 2026-07; prune/list calls pass a
// matching `now` so the default 30-day retention does not drop them.
const TEST_NOW = () => new Date("2026-07-22T00:00:00.000Z");

function makeRecord(patch: Partial<BatchOperationRecord> = {}): BatchOperationRecord {
  return createBatchOperationRecord({
    action: "release",
    trigger: "ui",
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:00:05.000Z",
    items: [
      { key: "101", name: "train-a", status: "succeeded", remoteTaskId: "task-101" },
      { key: "102", name: "train-b", status: "failed", error: "release rejected" },
    ],
    summary: { total: 2, succeeded: 1, failed: 1, skipped: 0, unknown: 0 },
    ...patch,
  });
}

describe("createBatchOperationRecord", () => {
  it("stamps unique ids and the active account", () => {
    const first = makeRecord();
    const second = makeRecord();
    expect(first.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);
    for (const record of [first, second]) {
      expect(record.accountKey).toBeTruthy();
      expect(typeof record.accountDisplayName).toBe("string");
    }
  });

  it("keeps an explicit account and id", () => {
    const record = makeRecord({ id: "fixed-id", accountKey: "owner@console", accountDisplayName: "Owner" });
    expect(record).toMatchObject({ id: "fixed-id", accountKey: "owner@console", accountDisplayName: "Owner" });
  });

  it("reports the active account scope without secrets", () => {
    const account = activeBatchOperationAccount();
    expect(account.accountKey).toBeTruthy();
    expect(typeof account.accountDisplayName).toBe("string");
  });
});

describe("appendBatchOperation / listBatchOperations", () => {
  it("appends and lists records newest first", async () => {
    const storage = memoryStorage();
    await appendBatchOperation(storage, makeRecord({ startedAt: "2026-07-21T10:00:00.000Z" }), { now: TEST_NOW });
    await appendBatchOperation(storage, makeRecord({ action: "delete", startedAt: "2026-07-21T11:00:00.000Z" }), { now: TEST_NOW });

    const records = await listBatchOperations(storage, { now: TEST_NOW });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ action: "delete", startedAt: "2026-07-21T11:00:00.000Z" });
    expect(records[1]).toMatchObject({ action: "release", startedAt: "2026-07-21T10:00:00.000Z" });
  });

  it("round-trips retryOf linking back to the original record", async () => {
    const storage = memoryStorage();
    const original = makeRecord();
    await appendBatchOperation(storage, original, { now: TEST_NOW });
    await appendBatchOperation(
      storage,
      makeRecord({ action: "release", startedAt: "2026-07-21T12:00:00.000Z", retryOf: original.id }),
      { now: TEST_NOW },
    );

    const records = await listBatchOperations(storage, { now: TEST_NOW });
    expect(records[0]!.retryOf).toBe(original.id);
    expect(records[1]!.retryOf).toBeUndefined();
  });

  it("prunes to the configured record limit", async () => {
    const storage = memoryStorage();
    for (let index = 0; index < 8; index += 1) {
      await appendBatchOperation(
        storage,
        makeRecord({ startedAt: new Date(Date.parse("2026-07-21T10:00:00.000Z") + index * 60_000).toISOString() }),
        { limit: 3, now: () => new Date("2026-07-21T12:00:00.000Z") },
      );
    }

    const records = await listBatchOperations(storage, { limit: 3, now: () => new Date("2026-07-21T12:00:00.000Z") });
    expect(records).toHaveLength(3);
    // The three newest survive.
    expect(records[0]!.startedAt).toBe(new Date(Date.parse("2026-07-21T10:00:00.000Z") + 7 * 60_000).toISOString());
    expect(records[2]!.startedAt).toBe(new Date(Date.parse("2026-07-21T10:00:00.000Z") + 5 * 60_000).toISOString());
  });

  it("drops records older than the retention window", () => {
    const fresh = makeRecord({ startedAt: "2026-07-21T09:00:00.000Z" });
    const stale = makeRecord({ startedAt: "2026-06-01T09:00:00.000Z" });
    const pruned = pruneBatchOperations([fresh, stale], { now: () => new Date("2026-07-21T10:00:00.000Z") });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.startedAt).toBe("2026-07-21T09:00:00.000Z");
  });

  it("reads records written by another instance over the same storage", async () => {
    // Two RuntimeStorage instances sharing one backing file, e.g. two windows
    // over the same app data or two CLI processes over the same local data.
    const shared = new Map<string, string>();
    const toStorage = (): RuntimeStorage => ({
      async get(key) {
        return shared.has(key) ? shared.get(key)! : null;
      },
      async set(key, value) {
        shared.set(key, value);
      },
      async remove(key) {
        shared.delete(key);
      },
    });

    await appendBatchOperation(toStorage(), makeRecord(), { now: TEST_NOW });
    const records = await listBatchOperations(toStorage(), { now: TEST_NOW });
    expect(records).toHaveLength(1);
    expect(records[0]!.items).toEqual([
      { key: "101", name: "train-a", status: "succeeded", remoteTaskId: "task-101" },
      { key: "102", name: "train-b", status: "failed", error: "release rejected" },
    ]);
  });

  it("writes under the reserved storage key", async () => {
    const storage = memoryStorage();
    await appendBatchOperation(storage, makeRecord(), { now: TEST_NOW });
    expect(await storage.get(BATCH_OPERATIONS_STORAGE_KEY)).toBeTruthy();
  });
});

describe("parseBatchOperations", () => {
  it("drops malformed stored records and items instead of failing the whole list", () => {
    const good = makeRecord();
    const raw = JSON.stringify([
      good,
      { id: "no-action", trigger: "ui", items: [] },
      "not-an-object",
      makeRecord({ id: "bad-trigger", action: "delete", trigger: "mystery" as never }),
      makeRecord({ id: "bad-items", items: "nope" as never }),
      makeRecord({
        id: "mixed-items",
        items: [{ key: "1", name: "ok", status: "succeeded" }, { key: "", name: "broken", status: "succeeded" }, 42 as unknown as BatchOperationItem],
      }),
    ]);
    const parsed = parseBatchOperations(raw);
    expect(parsed.map((record) => record.id)).toEqual([good.id, "mixed-items"]);
    expect(parsed[1]!.items).toEqual([{ key: "1", name: "ok", status: "succeeded" }]);
    // The summary is recomputed from the surviving items.
    expect(parsed[1]!.summary).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0, unknown: 0 });
  });

  it("returns an empty list for missing or non-JSON content", () => {
    expect(parseBatchOperations(null)).toEqual([]);
    expect(parseBatchOperations("not json")).toEqual([]);
    expect(parseBatchOperations('{"items":[]}')).toEqual([]);
  });
});

describe("updateBatchOperation / applyBatchItemResolutions", () => {
  it("revises one record in place and keeps the others", async () => {
    const first = makeRecord();
    const second = makeRecord({
      items: [
        { key: "1", name: "train-a", status: "unknown", error: "fetch dropped" },
        { key: "2", name: "train-b", status: "unknown", error: "fetch dropped" },
      ],
      summary: { total: 2, succeeded: 0, failed: 0, skipped: 0, unknown: 2 },
    });
    const storage = memoryStorage();
    await appendBatchOperation(storage, first, { now: TEST_NOW });
    await appendBatchOperation(storage, second, { now: TEST_NOW });

    const updated = await updateBatchOperation(
      storage,
      second.id,
      (record) =>
        applyBatchItemResolutions(
          record,
          new Map([
            ["1", { key: "1", status: "confirmed-not-created" }],
            ["2", { key: "2", status: "confirmed-created", remoteTaskId: "task-2" }],
          ]),
        ),
      { now: TEST_NOW },
    );

    expect(updated).not.toBeNull();
    expect(updated?.items).toEqual([
      { key: "1", name: "train-a", status: "failed", error: "fetch dropped" },
      { key: "2", name: "train-b", status: "succeeded", remoteTaskId: "task-2" },
    ]);
    expect(updated?.summary).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: 0, unknown: 0 });

    const stored = await listBatchOperations(storage, { now: TEST_NOW });
    expect(stored.map((record) => record.id)).toEqual([second.id, first.id]);
    expect(stored[1]?.items.every((item) => item.status !== "unknown")).toBe(true);
  });

  it("returns null when the id is unknown", async () => {
    const storage = memoryStorage();
    await appendBatchOperation(storage, makeRecord(), { now: TEST_NOW });
    const updated = await updateBatchOperation(storage, "missing", (record) => record, { now: TEST_NOW });
    expect(updated).toBeNull();
  });

  it("keeps unresolved items unknown and returns the same record", () => {
    const record = makeRecord({
      items: [
        { key: "1", name: "train-a", status: "unknown", error: "fetch dropped" },
        { key: "2", name: "train-b", status: "succeeded" },
      ],
      summary: { total: 2, succeeded: 1, failed: 0, skipped: 0, unknown: 1 },
    });
    const revised = applyBatchItemResolutions(record, new Map());
    expect(revised).toBe(record);
  });
});
