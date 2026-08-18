import type { RuntimeStorage } from "./types";

type RuntimeLockManager = {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

const keyQueues = new Map<string, Promise<unknown>>();

function enqueueKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  keyQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function withNavigatorLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined") return task();
  const locks = (navigator as Navigator & { locks?: RuntimeLockManager }).locks;
  if (!locks) return task();
  return locks.request(`easy-console.storage.${key}`, { mode: "exclusive" }, task);
}

/** Serialize get→modify→set for a storage key within and across tabs when locks exist. */
export async function withStorageLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  return enqueueKey(key, () => withNavigatorLock(key, task));
}

export async function updateStorageValue(
  storage: RuntimeStorage,
  key: string,
  updater: (current: string | null) => string | null | Promise<string | null>,
): Promise<string | null> {
  const apply = async () => {
    const current = await storage.get(key);
    const next = await updater(current);
    if (next === null) {
      await storage.remove(key);
      return null;
    }
    await storage.set(key, next);
    return next;
  };

  // `withStorageLock` only serializes within this process (plus other tabs via
  // navigator.locks). Stores shared across OS processes provide their own
  // cross-process transaction, which has to wrap the whole read-modify-write.
  return withStorageLock(key, () => (storage.withTransaction ? storage.withTransaction(apply) : apply()));
}

/**
 * Run a `load → modify → save` sequence as one cross-process unit.
 *
 * Deliberately does NOT go through `withStorageLock`: callers inside `fn`
 * reach `updateStorageValue`, which takes the per-key lock itself. Acquiring
 * the same key here first would make the inner call queue behind its own
 * caller and deadlock. The cross-process lock is reentrant, the per-key
 * process queue is not, so only the former belongs at this level.
 */
export async function withStorageTransaction<T>(storage: RuntimeStorage, fn: () => Promise<T>): Promise<T> {
  return storage.withTransaction ? storage.withTransaction(fn) : fn();
}
