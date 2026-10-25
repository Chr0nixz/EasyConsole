import { describe, expect, it } from "vitest";

import {
  createCachedWindowStorage,
  MAX_STORAGE_CAS_ATTEMPTS,
  type NativeStorageBackend,
  type StorageChangeBroadcast,
} from "./runtime";
import { updateStorageValue } from "./storage-mutex";
import type { RuntimeStorage } from "./types";

/**
 * Shared fake "native" backend: one store, serialized like the Rust-side
 * RUNTIME_STORAGE_LOCK, fanning out a change broadcast to every subscribed
 * window after each write. Each window gets its own labelled view plus a
 * per-window read counter so cache behavior is observable.
 */
function createFakeNativeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const subscribers = new Set<(event: StorageChangeBroadcast) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const broadcast = (event: StorageChangeBroadcast) => {
    for (const subscriber of [...subscribers]) subscriber(event);
  };

  function windowBackend(label: string) {
    let reads = 0;
    const backend: NativeStorageBackend = {
      get: (key) =>
        enqueue(async () => {
          reads += 1;
          return data.get(key) ?? null;
        }),
      set: (key, value) =>
        enqueue(async () => {
          data.set(key, value);
          broadcast({ key, source: label });
        }),
      remove: (key) =>
        enqueue(async () => {
          const existed = data.delete(key);
          if (existed) broadcast({ key, source: label });
        }),
      compareAndSwap: (key, expected, next) =>
        enqueue(async () => {
          const current = data.get(key) ?? null;
          if (current !== expected) return { updated: false as const, current };
          if (next === null) data.delete(key);
          else data.set(key, next);
          broadcast({ key, source: label });
          return { updated: true as const, current: next };
        }),
    };
    return { backend, readCount: () => reads };
  }

  return {
    windowBackend,
    subscribeChanges: async (handler: (event: StorageChangeBroadcast) => void) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
}

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

function createWindowPair(initial: Record<string, string> = {}) {
  const store = createFakeNativeStore(initial);
  const build = (label: string) => {
    const { backend, readCount } = store.windowBackend(label);
    const storage = createCachedWindowStorage({
      backend,
      subscribeChanges: store.subscribeChanges,
      selfLabel: async () => label,
      fallback: memoryStorage(),
    });
    return { storage, readCount };
  };
  return { windowA: build("main"), windowB: build("ssh-1") };
}

describe("cross-window storage cache", () => {
  it("serves window A the value window B just wrote (no stale cache)", async () => {
    const { windowA, windowB } = createWindowPair({ "easy-console.k": "v1" });

    expect(await windowA.storage.get("easy-console.k")).toBe("v1");
    await windowB.storage.set("easy-console.k", "v2");

    const afterBWrite = await windowA.storage.get("easy-console.k");
    expect(afterBWrite).toBe("v2");
    // The invalidation really forced a re-read instead of serving the cache.
    expect(windowA.readCount()).toBe(2);
  });

  it("does not churn the cache for a window's own writes", async () => {
    const { windowA, windowB } = createWindowPair({ "easy-console.k": "v1" });

    expect(await windowA.storage.get("easy-console.k")).toBe("v1");
    expect(windowA.readCount()).toBe(1);

    await windowA.storage.set("easy-console.k", "v3");
    // Self-broadcast must be ignored: the next read stays a cache hit.
    expect(await windowA.storage.get("easy-console.k")).toBe("v3");
    expect(windowA.readCount()).toBe(1);

    // Foreign writes still invalidate after a self-write.
    await windowB.storage.set("easy-console.k", "v4");
    expect(await windowA.storage.get("easy-console.k")).toBe("v4");
    expect(windowA.readCount()).toBe(2);
  });

  it("does not cache a stale read that resolves after another window's write", async () => {
    const shared = new Map<string, string>([["easy-console.k", "v1"]]);
    const subscribers = new Set<(event: StorageChangeBroadcast) => void>();
    const broadcast = (event: StorageChangeBroadcast) => {
      for (const subscriber of [...subscribers]) subscriber(event);
    };

    let releaseStaleRead!: (value: string | null) => void;
    const staleRead = new Promise<string | null>((resolve) => {
      releaseStaleRead = resolve;
    });
    let firstRead = true;
    const backendA: NativeStorageBackend = {
      get: async (key) => {
        if (firstRead) {
          firstRead = false;
          return staleRead; // simulates a slow IPC response captured before B's write
        }
        return shared.get(key) ?? null;
      },
      set: async (key, value) => {
        shared.set(key, value);
        broadcast({ key, source: "main" });
      },
      remove: async (key) => {
        shared.delete(key);
      },
      compareAndSwap: async () => {
        throw new Error("not used in this test");
      },
    };
    const backendB: NativeStorageBackend = {
      get: async (key) => shared.get(key) ?? null,
      set: async (key, value) => {
        shared.set(key, value);
        broadcast({ key, source: "ssh-1" });
      },
      remove: async (key) => {
        shared.delete(key);
      },
      compareAndSwap: async () => {
        throw new Error("not used in this test");
      },
    };
    const subscribe = async (handler: (event: StorageChangeBroadcast) => void) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    };
    const windowA = createCachedWindowStorage({
      backend: backendA,
      subscribeChanges: subscribe,
      selfLabel: async () => "main",
      fallback: memoryStorage(),
    });
    const windowB = createCachedWindowStorage({
      backend: backendB,
      subscribeChanges: subscribe,
      selfLabel: async () => "ssh-1",
      fallback: memoryStorage(),
    });

    const firstGet = windowA.get("easy-console.k");
    // Let both subscriptions register before B writes (they settle on microtasks).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await windowB.set("easy-console.k", "v2");
    releaseStaleRead("v1");

    await expect(firstGet).resolves.toBe("v1"); // the caller still gets its own response
    await expect(windowA.get("easy-console.k")).resolves.toBe("v2"); // but the cache was not poisoned
  });
});

describe("cross-window read-modify-write", () => {
  const parse = (raw: string | null) => JSON.parse(raw ?? "[]") as string[];
  const append = (raw: string | null, item: string) => JSON.stringify([...parse(raw), item]);

  it("keeps both windows' concurrent appends to the same array", async () => {
    const { windowA, windowB } = createWindowPair({ "easy-console.list": JSON.stringify(["seed"]) });

    await Promise.all([
      updateStorageValue(windowA.storage, "easy-console.list", (raw) => append(raw, "from-A")),
      updateStorageValue(windowB.storage, "easy-console.list", (raw) => append(raw, "from-B")),
    ]);

    const finalList = parse(await windowA.storage.get("easy-console.list"));
    expect(finalList).toHaveLength(3);
    expect(finalList).toContain("from-A");
    expect(finalList).toContain("from-B");
    expect(await windowB.storage.get("easy-console.list")).toBe(await windowA.storage.get("easy-console.list"));
  });

  it("retries the transform on the fresh value after losing a CAS race", async () => {
    const { windowA, windowB } = createWindowPair({ "easy-console.list": JSON.stringify(["seed"]) });

    // Park A inside its first transform; let B win the write; then release A.
    let enterUpdater!: () => void;
    const updaterEntered = new Promise<void>((resolve) => {
      enterUpdater = resolve;
    });
    let releaseUpdater!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseUpdater = resolve;
    });

    const aUpdate = updateStorageValue(windowA.storage, "easy-console.list", async (raw) => {
      enterUpdater();
      await releaseGate;
      return append(raw, "from-A");
    });
    await updaterEntered;
    // B bypasses updateStorageValue on purpose: within one process the shared
    // per-key lock would queue B behind A's parked transform. Real windows each
    // own a lock, so B writes through the storage adapter directly.
    await windowB.storage.update!("easy-console.list", (raw) => append(raw, "from-B"));
    releaseUpdater();
    await expect(aUpdate).resolves.toBeTruthy();

    const finalList = parse(await windowA.storage.get("easy-console.list"));
    expect(finalList.sort()).toEqual(["from-A", "from-B", "seed"]);
  });

  it("gives up with an error after too many cross-window conflicts", async () => {
    createWindowPair({ "easy-console.k": "v0" });

    // A hostile backend that always reports a conflict with a changing value.
    let rounds = 0;
    const conflictingBackend: NativeStorageBackend = {
      get: async () => `v${rounds}`,
      set: async () => undefined,
      remove: async () => undefined,
      compareAndSwap: async (_key, _expected, next) => {
        rounds += 1;
        return { updated: false, current: next ?? `v${rounds}` };
      },
    };
    const storage = createCachedWindowStorage({
      backend: conflictingBackend,
      subscribeChanges: async () => async () => undefined,
      selfLabel: async () => "main",
      fallback: memoryStorage(),
    });

    await expect(storage.update!("easy-console.k", (raw) => `${raw}+x`)).rejects.toThrow(/cross-window conflicts|窗口冲突/);
    expect(rounds).toBe(MAX_STORAGE_CAS_ATTEMPTS);
  });

  it("degrades to a plain write when the native CAS command fails", async () => {
    const shared = new Map<string, string>([["easy-console.k", "v1"]]);
    const backend: NativeStorageBackend = {
      get: async (key) => shared.get(key) ?? null,
      set: async (key, value) => {
        shared.set(key, value);
      },
      remove: async (key) => {
        shared.delete(key);
      },
      compareAndSwap: async () => {
        throw new Error("command unavailable");
      },
    };
    const storage = createCachedWindowStorage({
      backend,
      subscribeChanges: async () => async () => undefined,
      selfLabel: async () => "main",
      fallback: memoryStorage(),
    });

    await expect(storage.update!("easy-console.k", (raw) => `${raw}-updated`)).resolves.toBe("v1-updated");
    expect(shared.get("easy-console.k")).toBe("v1-updated");
  });
});
