import { describe, expect, it } from "vitest";

import { makeAccountScope } from "./account-scope";
import { EXECUTION_LEDGER_STORAGE_KEY, listExecutionLedger } from "./execution-ledger";
import {
  applyExecutionOutcome,
  beginScheduledExecution,
  completeScheduledExecution,
  executeScheduledTask,
  makeExecutionKey,
  reconcileStaleRunningTasks,
} from "./schedule-execution";
import { isScheduleDue, loadScheduledTasks, saveScheduledTasks } from "./scheduled-tasks";
import { ApiError, type RuntimeStorage, type ScheduledTask } from "./types";

function makeTask(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sch-1",
    name: "train",
    scheduleTime: "2026-07-21T10:00:00.000Z",
    status: "pending",
    payload: { name: "train" },
    createdAt: "2026-07-21T01:00:00.000Z",
    updatedAt: "2026-07-21T01:00:00.000Z",
    ...patch,
  };
}

describe("schedule-execution", () => {
  it("builds a stable execution key from id and scheduleTime", () => {
    expect(makeExecutionKey(makeTask())).toBe("sch-1@2026-07-21T10:00:00.000Z");
  });

  it("begins a lease before remote create", () => {
    const now = new Date("2026-07-21T10:01:00.000Z");
    const leased = beginScheduledExecution(makeTask(), now);
    expect(leased.status).toBe("running");
    expect(leased.executionKey).toBe("sch-1@2026-07-21T10:00:00.000Z");
    expect(leased.leaseStartedAt).toBe(now.toISOString());
  });

  it("advances schedule after successful remote create for recurring tasks", () => {
    const task = makeTask({
      status: "running",
      executionKey: "sch-1@2026-07-21T10:00:00.000Z",
      leaseStartedAt: "2026-07-21T10:00:00.000Z",
      recurrence: { type: "interval", intervalSec: 3600 },
    });
    const next = completeScheduledExecution(task, "remote-42", new Date("2026-07-21T10:00:05.000Z"));
    expect(next.lastRemoteTaskId).toBe("remote-42");
    expect(next.status).toBe("pending");
    expect(next.leaseStartedAt).toBeUndefined();
    expect(Date.parse(next.scheduleTime)).toBeGreaterThan(Date.parse(task.scheduleTime));
  });

  it("marks stale running leases as needs_review instead of pending", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const stale = makeTask({
      status: "running",
      executionKey: "sch-1@2026-07-21T10:00:00.000Z",
      leaseStartedAt: "2026-07-21T10:00:00.000Z",
      lastRemoteTaskId: "remote-9",
    });
    const fresh = makeTask({
      id: "sch-2",
      status: "running",
      scheduleTime: "2026-07-21T11:55:00.000Z",
      executionKey: "sch-2@2026-07-21T11:55:00.000Z",
      leaseStartedAt: "2026-07-21T11:55:00.000Z",
    });
    const result = reconcileStaleRunningTasks([stale, fresh], now, 15 * 60 * 1000);
    expect(result[0].status).toBe("needs_review");
    expect(result[0].lastRemoteTaskId).toBe("remote-9");
    expect(result[1].status).toBe("running");
  });

  it("does not auto-replay after needs_review (isScheduleDue false)", async () => {
    const { isScheduleDue } = await import("./scheduled-tasks");
    const task = makeTask({
      status: "needs_review",
      scheduleTime: "2026-07-21T09:00:00.000Z",
      executionKey: "sch-1@2026-07-21T09:00:00.000Z",
      lastRemoteTaskId: "remote-1",
    });
    expect(isScheduleDue(task, new Date("2026-07-21T12:00:00.000Z"))).toBe(false);
  });
});

function createMemoryStorage(): RuntimeStorage {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

describe("executeScheduledTask", () => {
  it("checks ownership against the latest stored plan even for a forced manual run", async () => {
    const storage = createMemoryStorage();
    const owner = makeAccountScope("alice", "Alice", "http://console.example/api");
    await saveScheduledTasks(storage, [makeTask({ owner })]);
    let creates = 0;
    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => { creates += 1; return { id: "wrong-account" }; },
      getAccountScope: () => makeAccountScope("bob", "Bob", "http://console.example/api"),
      force: true,
    });
    expect(result).toMatchObject({ skipped: true, reason: "not-runnable", task: { status: "needs_review", owner } });
    expect((await loadScheduledTasks(storage))[0]).toMatchObject({ status: "needs_review", owner });
    expect(creates).toBe(0);
  });

  it("rechecks the account after asynchronous payload preparation before submitting", async () => {
    const storage = createMemoryStorage();
    const owner = makeAccountScope("alice", "Alice", "http://console.example/api");
    await saveScheduledTasks(storage, [makeTask({ owner })]);
    let active = owner;
    let creates = 0;
    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => { creates += 1; return { id: "wrong-account" }; },
      getAccountScope: () => active,
      preparePayload: async (payload) => {
        active = makeAccountScope("bob", "Bob", "http://console.example/api");
        return payload;
      },
      force: true,
    });
    expect(result).toMatchObject({ skipped: true, reason: "not-runnable", task: { status: "needs_review" } });
    expect((await loadScheduledTasks(storage))[0]).toMatchObject({ status: "needs_review", owner });
    expect(creates).toBe(0);
  });

  it("recomputes timed release as 24 hours after the current scheduled run", async () => {
    const storage = createMemoryStorage();
    const task = makeTask({
      scheduleTime: "2026-07-21T10:00:00.000Z",
      payload: {
        name: "train",
        releace_conditions: 2,
        releace_time: "2026-07-21 10:00:00",
      },
    });
    await saveScheduledTasks(storage, [task]);
    let submittedReleaseTime = "";

    await executeScheduledTask(storage, task.id, {
      createTask: async (payload) => {
        submittedReleaseTime = String(payload.releace_time ?? "");
        return { id: "remote-24h" };
      },
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
    });

    const submittedAt = Date.parse(submittedReleaseTime.replace(" ", "T"));
    expect(submittedAt - Date.parse(task.scheduleTime)).toBe(24 * 60 * 60 * 1000);
  });

  it("advances a recurring task instead of marking it done", async () => {
    const storage = createMemoryStorage();
    const task = makeTask({
      recurrence: { type: "interval", intervalSec: 3600 },
    });
    await saveScheduledTasks(storage, [task]);
    const now = new Date("2026-07-21T10:00:05.000Z");

    const result = await executeScheduledTask(storage, task.id, {
      createTask: async () => ({ id: "remote-42" }),
      force: true,
      now,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.remoteTaskId).toBe("remote-42");
    expect(result.task.status).toBe("pending");
    expect(Date.parse(result.task.scheduleTime)).toBeGreaterThan(Date.parse(task.scheduleTime));
    expect((await loadScheduledTasks(storage))[0]?.status).toBe("pending");
  });

  it("skips a second claim while a fresh lease is in flight", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    let resumeCreate: () => void = () => undefined;
    let createEntered = false;
    const first = executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        createEntered = true;
        await new Promise<void>((resolve) => {
          resumeCreate = resolve;
        });
        return { id: "remote-1" };
      },
      force: true,
      now: new Date("2026-07-21T10:01:00.000Z"),
    });

    await expect.poll(() => createEntered).toBe(true);

    const second = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-2" }),
      force: true,
      now: new Date("2026-07-21T10:01:01.000Z"),
    });
    expect(second).toMatchObject({ skipped: true, reason: "in-flight" });

    resumeCreate();
    const firstResult = await first;
    expect(firstResult.skipped).toBe(false);
  });

  it("does not replay a needs_review row that already created a remote task", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [
      makeTask({
        status: "needs_review",
        executionKey: "sch-1@2026-07-21T10:00:00.000Z",
        lastRemoteTaskId: "remote-9",
        lastError: "lease expired",
      }),
    ]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-should-not-create" }),
      force: true,
      now: new Date("2026-07-21T10:01:00.000Z"),
    });
    expect(result).toMatchObject({ skipped: true, reason: "already-completed" });
  });
});

/**
 * Storage whose `set` throws on the given call indexes (0-based, in call
 * order) to inject local persistence faults at exact points in the flow:
 * set#0 saveScheduledTasks, set#1 lease claim, then completion/review writes.
 */
function createScriptedStorage(failSetIndexes: number[]): RuntimeStorage & { setCalls: () => number } {
  const data = new Map<string, string>();
  let setCalls = 0;
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      const index = setCalls;
      setCalls += 1;
      if (failSetIndexes.includes(index)) throw new Error("disk full");
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
    setCalls: () => setCalls,
  };
}

describe("executeScheduledTask failure boundaries", () => {
  it("marks the row failed when the remote create is definitively rejected", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);
    let creates = 0;

    await expect(
      executeScheduledTask(storage, "sch-1", {
        createTask: async () => {
          creates += 1;
          throw new ApiError("quota exceeded", { code: 10040, kind: "business" });
        },
        force: true,
        now: new Date("2026-07-21T10:00:05.000Z"),
      }),
    ).rejects.toThrow("quota exceeded");

    const row = (await loadScheduledTasks(storage))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("quota exceeded");
    expect(row.lastRemoteTaskId).toBeUndefined();
    expect(creates).toBe(1);
  });

  it("parks the row in needs_review when the create request fails at the network level (outcome unknown)", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);
    let creates = 0;

    await expect(
      executeScheduledTask(storage, "sch-1", {
        createTask: async () => {
          creates += 1;
          throw new ApiError("Network request failed", { kind: "network" });
        },
        force: true,
        now: new Date("2026-07-21T10:00:05.000Z"),
      }),
    ).rejects.toThrow("Network request failed");

    const row = (await loadScheduledTasks(storage))[0]!;
    expect(row.status).toBe("needs_review");
    expect(row.lastRemoteTaskId).toBeUndefined();
    expect(row.lastError).toBeTruthy();

    // Auto runners must never replay an unknown outcome.
    expect(isScheduleDue(row, new Date("2026-07-21T12:00:00.000Z"))).toBe(false);
    const rerun = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        creates += 1;
        return { id: "remote-duplicate" };
      },
      now: new Date("2026-07-21T10:00:06.000Z"),
    });
    expect(rerun).toMatchObject({ skipped: true, reason: "not-runnable" });
    expect(creates).toBe(1);
  });

  it("keeps the remote task id and reports local-persist-failed when every local write after the remote create fails", async () => {
    // set#0 save, set#1 lease claim succeed; set#2 completion write and set#3
    // review-marker write both fail (attempts=0, storage still broken).
    const storage = createScriptedStorage([2, 3]);
    await saveScheduledTasks(storage, [makeTask()]);
    let creates = 0;

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        creates += 1;
        return { id: "remote-77" };
      },
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
      persistRetryAttempts: 0,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.outcome).toBe("local-persist-failed");
    expect(result.remoteTaskId).toBe("remote-77");
    expect(result.task.status).toBe("needs_review");
    expect(result.task.lastRemoteTaskId).toBe("remote-77");
    expect(result.task.lastError).toBeTruthy();
    expect(creates).toBe(1);

    // Nothing after the lease could be written: the row is still "running".
    // The stale-lease reconcile is what moves it to needs_review later.
    const row = (await loadScheduledTasks(storage))[0]!;
    expect(row.status).toBe("running");
    const reconciled = reconcileStaleRunningTasks(
      [row],
      new Date("2026-07-21T11:00:00.000Z"),
      15 * 60 * 1000,
    );
    expect(reconciled[0]?.status).toBe("needs_review");
  });

  it("never re-creates the remote task when a manual re-run hits the persisted needs_review row", async () => {
    // set#2 completion write fails; set#3 review marker succeeds.
    const storage = createScriptedStorage([2]);
    await saveScheduledTasks(storage, [makeTask()]);
    let creates = 0;

    const first = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        creates += 1;
        return { id: "remote-77" };
      },
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
      persistRetryAttempts: 0,
    });
    expect(first.skipped).toBe(false);
    if (first.skipped) return;
    expect(first.outcome).toBe("local-persist-failed");

    const persisted = (await loadScheduledTasks(storage))[0]!;
    expect(persisted.status).toBe("needs_review");
    expect(persisted.lastRemoteTaskId).toBe("remote-77");

    const rerun = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => {
        creates += 1;
        return { id: "remote-duplicate" };
      },
      force: true,
      now: new Date("2026-07-21T10:01:00.000Z"),
    });
    expect(rerun).toMatchObject({ skipped: true, reason: "already-completed" });
    expect(creates).toBe(1);
  });

  it("retries the local completion write after a transient storage failure", async () => {
    // set#2 (first completion attempt) fails; the retry at set#3 succeeds.
    const storage = createScriptedStorage([2]);
    await saveScheduledTasks(storage, [makeTask()]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-9" }),
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
      persistRetryAttempts: 2,
      persistRetryDelayMs: 0,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.outcome).toBe("completed");
    expect(result.task.status).toBe("done");
    expect(result.task.lastRemoteTaskId).toBe("remote-9");
    expect(storage.setCalls()).toBeGreaterThanOrEqual(4);
    const row = (await loadScheduledTasks(storage))[0]!;
    expect(row.status).toBe("done");
    expect(row.lastRemoteTaskId).toBe("remote-9");
  });

  it("preserves concurrent edits from another window when persisting the review marker", async () => {
    const data = new Map<string, string>();
    let setCalls = 0;
    const storage: RuntimeStorage = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => {
        const index = setCalls;
        setCalls += 1;
        if (index === 2) {
          // The completion write fails; meanwhile another window renames the row.
          const rows = JSON.parse(data.get(key) ?? "[]") as ScheduledTask[];
          data.set(key, JSON.stringify(rows.map((row) => (row.id === "sch-1" ? { ...row, name: "renamed-elsewhere" } : row))));
          throw new Error("disk full");
        }
        data.set(key, value);
      },
      remove: async (key) => {
        data.delete(key);
      },
    };
    await saveScheduledTasks(storage, [makeTask()]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-5" }),
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
      persistRetryAttempts: 0,
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.outcome).toBe("local-persist-failed");
    const row = (await loadScheduledTasks(storage))[0]!;
    expect(row.name).toBe("renamed-elsewhere"); // concurrent edit survives
    expect(row.status).toBe("needs_review"); // marker applied on top
    expect(row.lastRemoteTaskId).toBe("remote-5");
  });
});

describe("executeScheduledTask execution ledger", () => {
  it("records a completed outcome with the remote task id and the default schedule trigger", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-42" }),
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
    });
    expect(result.skipped).toBe(false);

    const entries = await listExecutionLedger(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scheduledTaskId: "sch-1",
      scheduledTaskName: "train",
      trigger: "schedule",
      outcome: "completed",
      remoteTaskId: "remote-42",
    });
    expect(entries[0]!.startedAt).toBeTruthy();
    expect(entries[0]!.finishedAt).toBeTruthy();
  });

  it("records the manual trigger when provided", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-1" }),
      force: true,
      trigger: "manual",
      now: new Date("2026-07-21T10:00:05.000Z"),
    });

    const entries = await listExecutionLedger(storage);
    expect(entries[0]!.trigger).toBe("manual");
  });

  it("records local-persist-failed with the kept remote task id and the persist error", async () => {
    // set#0 save, set#1 lease claim succeed; every later write fails, so the
    // completion retry and the review marker both fail.
    const storage = createScriptedStorage([2, 3]);
    await saveScheduledTasks(storage, [makeTask()]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-77" }),
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
      persistRetryAttempts: 0,
    });
    expect(result.skipped).toBe(false);

    const entries = await listExecutionLedger(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "local-persist-failed",
      remoteTaskId: "remote-77",
    });
    expect(entries[0]!.error).toBeTruthy();
  });

  it("records an unknown outcome when the create fails at the network level", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    await expect(
      executeScheduledTask(storage, "sch-1", {
        createTask: async () => {
          throw new ApiError("Network request failed", { kind: "network" });
        },
        force: true,
        now: new Date("2026-07-21T10:00:05.000Z"),
      }),
    ).rejects.toThrow("Network request failed");

    const entries = await listExecutionLedger(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "unknown", scheduledTaskId: "sch-1" });
    expect(entries[0]!.remoteTaskId).toBeUndefined();
    expect(entries[0]!.error).toContain("Network request failed");
  });

  it("records a failed outcome when the remote create is definitively rejected", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask()]);

    await expect(
      executeScheduledTask(storage, "sch-1", {
        createTask: async () => {
          throw new ApiError("quota exceeded", { code: 10040, kind: "business" });
        },
        force: true,
        now: new Date("2026-07-21T10:00:05.000Z"),
      }),
    ).rejects.toThrow("quota exceeded");

    const entries = await listExecutionLedger(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "failed", scheduledTaskId: "sch-1" });
    expect(entries[0]!.remoteTaskId).toBeUndefined();
    expect(entries[0]!.error).toContain("quota exceeded");
  });

  it("does not record an entry for skipped executions", async () => {
    const storage = createMemoryStorage();
    await saveScheduledTasks(storage, [makeTask({ status: "paused" })]);

    const skipped = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "should-not-run" }),
      now: new Date("2026-07-21T10:00:05.000Z"),
    });
    expect(skipped.skipped).toBe(true);
    await expect(listExecutionLedger(storage)).resolves.toEqual([]);
  });

  it("never fails the execution when the ledger write itself is broken", async () => {
    const data = new Map<string, string>();
    const storage: RuntimeStorage = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value) => {
        if (key === EXECUTION_LEDGER_STORAGE_KEY) throw new Error("ledger disk full");
        data.set(key, value);
      },
      remove: async (key) => {
        data.delete(key);
      },
    };
    await saveScheduledTasks(storage, [makeTask()]);

    const result = await executeScheduledTask(storage, "sch-1", {
      createTask: async () => ({ id: "remote-9" }),
      force: true,
      now: new Date("2026-07-21T10:00:05.000Z"),
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.outcome).toBe("completed");
    expect(result.remoteTaskId).toBe("remote-9");
  });
});

describe("applyExecutionOutcome", () => {
  it("overlays execution bookkeeping without clobbering concurrent edits", () => {
    const latest = makeTask({
      name: "renamed-elsewhere",
      payload: { name: "renamed-elsewhere" },
      status: "running",
      executionKey: "sch-1@2026-07-21T10:00:00.000Z",
      leaseStartedAt: "2026-07-21T10:00:00.000Z",
    });
    const outcome = makeTask({
      name: "stale-snapshot-name",
      status: "needs_review",
      lastError: "marker",
      lastRemoteTaskId: "remote-1",
      leaseStartedAt: undefined,
      updatedAt: "2026-07-21T10:00:09.000Z",
    });

    const merged = applyExecutionOutcome(latest, outcome);

    expect(merged.name).toBe("renamed-elsewhere");
    expect(merged.payload).toEqual({ name: "renamed-elsewhere" });
    expect(merged.status).toBe("needs_review");
    expect(merged.lastError).toBe("marker");
    expect(merged.lastRemoteTaskId).toBe("remote-1");
    expect(merged.leaseStartedAt).toBeUndefined();
  });

  it("keeps the latest remote id and execution key when the outcome carries none", () => {
    const merged = applyExecutionOutcome(
      makeTask({ lastRemoteTaskId: "remote-9", executionKey: "sch-1@old" }),
      makeTask({ lastRemoteTaskId: undefined, executionKey: undefined, status: "failed", lastError: "boom" }),
    );
    expect(merged.lastRemoteTaskId).toBe("remote-9");
    expect(merged.executionKey).toBe("sch-1@old");
    expect(merged.status).toBe("failed");
  });
});
