import { describe, expect, it } from "vitest";

import {
  activeExecutionAccount,
  appendExecutionLedgerEntry,
  appendHeldOwnerMismatchEntry,
  createExecutionLedgerEntry,
  EXECUTION_LEDGER_STORAGE_KEY,
  listExecutionLedger,
  parseExecutionLedger,
  pruneExecutionLedger,
  resolveExecutionLedgerEntry,
  type ExecutionLedgerEntry,
  type ExecutionOutcome,
} from "./execution-ledger";
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

// Entries in these tests are backdated to 2026-07; prune/list calls must pass
// a matching `now` so the default 30-day retention (measured against the real
// clock) does not drop them.
const TEST_NOW = () => new Date("2026-07-22T00:00:00.000Z");

function makeEntry(patch: Partial<ExecutionLedgerEntry> = {}): ExecutionLedgerEntry {
  return createExecutionLedgerEntry({
    scheduledTaskId: "sch-1",
    scheduledTaskName: "train",
    trigger: "schedule",
    accountKey: "owner-a@console",
    accountDisplayName: "Owner A",
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:00:05.000Z",
    outcome: "completed",
    remoteTaskId: "remote-1",
    ...patch,
  });
}

describe("execution-ledger entries", () => {
  it("stamps unique ids on created entries", () => {
    const first = makeEntry();
    const second = makeEntry();
    expect(first.id).toBeTruthy();
    expect(second.id).not.toBe(first.id);
  });

  it("reports the active account scope without secrets", () => {
    const account = activeExecutionAccount();
    expect(account.accountKey).toBeTruthy();
    expect(typeof account.accountDisplayName).toBe("string");
  });
});

describe("appendExecutionLedgerEntry / listExecutionLedger", () => {
  it("lists entries newest first", async () => {
    const storage = memoryStorage();
    await appendExecutionLedgerEntry(storage, makeEntry({ startedAt: "2026-07-21T10:00:00.000Z" }), { now: TEST_NOW });
    await appendExecutionLedgerEntry(storage, makeEntry({ startedAt: "2026-07-21T11:00:00.000Z", outcome: "failed" }), { now: TEST_NOW });

    const entries = await listExecutionLedger(storage, { now: TEST_NOW });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.startedAt).toBe("2026-07-21T11:00:00.000Z");
    expect(entries[0]!.outcome).toBe("failed");
    expect(entries[1]!.startedAt).toBe("2026-07-21T10:00:00.000Z");
  });

  it("prunes to the configured limit", async () => {
    const storage = memoryStorage();
    for (let index = 0; index < 12; index += 1) {
      await appendExecutionLedgerEntry(
        storage,
        makeEntry({ startedAt: new Date(Date.parse("2026-07-21T10:00:00.000Z") + index * 60_000).toISOString() }),
        { limit: 5, retentionDays: 30, now: () => new Date("2026-07-21T12:00:00.000Z") },
      );
    }

    const entries = await listExecutionLedger(storage, { limit: 5, now: () => new Date("2026-07-21T12:00:00.000Z") });
    expect(entries).toHaveLength(5);
    // The five newest survive.
    expect(entries[0]!.startedAt).toBe(new Date(Date.parse("2026-07-21T10:00:00.000Z") + 11 * 60_000).toISOString());
    expect(entries[4]!.startedAt).toBe(new Date(Date.parse("2026-07-21T10:00:00.000Z") + 7 * 60_000).toISOString());
  });

  it("prunes entries older than the retention window", () => {
    const fresh = makeEntry({ startedAt: "2026-07-21T09:00:00.000Z" });
    const stale = makeEntry({ startedAt: "2026-06-01T09:00:00.000Z" });
    const pruned = pruneExecutionLedger([fresh, stale], { now: () => new Date("2026-07-21T10:00:00.000Z") });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.startedAt).toBe("2026-07-21T09:00:00.000Z");
  });

  it("drops malformed stored entries instead of failing the whole list", () => {
    const good = makeEntry();
    const raw = JSON.stringify([
      good,
      { id: "no-task-id", outcome: "completed" },
      "not-an-object",
      makeEntry({ id: "bad-outcome", outcome: "mystery" as unknown as ExecutionOutcome }),
    ]);
    const parsed = parseExecutionLedger(raw);
    expect(parsed.map((item) => item.id)).toEqual([good.id]);
  });
});

describe("resolveExecutionLedgerEntry", () => {
  it("round-trips a resolution onto the stored entry", async () => {
    const storage = memoryStorage();
    const entry = makeEntry({ outcome: "unknown" });
    await appendExecutionLedgerEntry(storage, entry, { now: TEST_NOW });

    const updated = await resolveExecutionLedgerEntry(storage, entry.id, {
      status: "confirmed-created",
      resolvedAt: "2026-07-21T12:00:00.000Z",
      note: "verified on the console",
    });
    expect(updated).toMatchObject({
      id: entry.id,
      outcome: "unknown",
      resolution: { status: "confirmed-created", resolvedAt: "2026-07-21T12:00:00.000Z", note: "verified on the console" },
    });

    const listed = await listExecutionLedger(storage, { now: TEST_NOW });
    expect(listed[0]!.resolution?.status).toBe("confirmed-created");
  });

  it("replaces an existing resolution", async () => {
    const storage = memoryStorage();
    const entry = makeEntry({ outcome: "unknown" });
    await appendExecutionLedgerEntry(storage, entry, { now: TEST_NOW });
    await resolveExecutionLedgerEntry(storage, entry.id, {
      status: "confirmed-created",
      resolvedAt: "2026-07-21T12:00:00.000Z",
    });
    await resolveExecutionLedgerEntry(storage, entry.id, {
      status: "confirmed-not-created",
      resolvedAt: "2026-07-21T13:00:00.000Z",
    });

    const listed = await listExecutionLedger(storage, { now: TEST_NOW });
    expect(listed[0]!.resolution).toMatchObject({ status: "confirmed-not-created", resolvedAt: "2026-07-21T13:00:00.000Z" });
  });

  it("returns undefined for an unknown id", async () => {
    const storage = memoryStorage();
    await expect(
      resolveExecutionLedgerEntry(storage, "missing", { status: "confirmed-created", resolvedAt: "2026-07-21T12:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });
});

describe("appendHeldOwnerMismatchEntry", () => {
  it("records the hold without a remote attempt", async () => {
    const storage = memoryStorage();
    const now = new Date("2026-07-21T10:00:00.000Z");
    await appendHeldOwnerMismatchEntry(storage, { id: "sch-9", name: "gpu-bench" }, "owner mismatch: other account", {
      now: () => now,
    });

    const entries = await listExecutionLedger(storage, { now: () => now });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scheduledTaskId: "sch-9",
      scheduledTaskName: "gpu-bench",
      trigger: "schedule",
      outcome: "held-owner-mismatch",
      error: "owner mismatch: other account",
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
    });
    expect(entries[0]!.remoteTaskId).toBeUndefined();
  });

  it("swallows storage failures so the runner is never interrupted", async () => {
    const storage: RuntimeStorage = {
      ...memoryStorage(),
      async set() {
        throw new Error("disk full");
      },
    };
    await expect(
      appendHeldOwnerMismatchEntry(storage, { id: "sch-9", name: "gpu-bench" }, "reason"),
    ).resolves.toBeUndefined();
  });

  it("writes under the reserved storage key", async () => {
    const storage = memoryStorage();
    await appendExecutionLedgerEntry(storage, makeEntry(), { now: TEST_NOW });
    expect(await storage.get(EXECUTION_LEDGER_STORAGE_KEY)).toBeTruthy();
  });
});
