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
  return withStorageLock(key, async () => {
    const current = await storage.get(key);
    const next = await updater(current);
    if (next === null) {
      await storage.remove(key);
      return null;
    }
    await storage.set(key, next);
    return next;
  });
}
