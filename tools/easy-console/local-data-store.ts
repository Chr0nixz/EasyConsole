import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import type { RuntimeStorage } from "../../src/lib/types";

export function getDefaultLocalDataPath(configPath: string) {
  return process.env.EASY_CONSOLE_LOCAL_DATA_PATH ?? join(dirname(configPath), "local-data.json");
}

/**
 * Files whose cross-process lock is held by the *current async call chain*.
 *
 * proper-lockfile is not reentrant, so a transaction whose body calls get/set
 * on the same store must reuse the lock it already holds. Tracking that in a
 * plain module-level map keyed by path would be wrong: two genuinely concurrent
 * callers would each see "already held" and skip locking, silently destroying
 * mutual exclusion. AsyncLocalStorage scopes the flag to one call chain, so
 * nested calls reuse the lock while independent callers still contend for it.
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: { initialContents?: string } = {},
): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(filePath)) return fn();

  await mkdir(dirname(filePath), { recursive: true });
  // proper-lockfile needs the target to exist before it can lock it.
  try {
    await writeFile(filePath, options.initialContents ?? "", { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      // ignore non-EEXIST; the lock call below will surface real errors
    }
  }

  const release = await lockfile.lock(filePath, {
    retries: { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 500 },
    stale: 30_000,
  });
  const nested = new Set(held ?? []);
  nested.add(filePath);
  try {
    return await heldLocks.run(nested, fn);
  } finally {
    await release();
  }
}

export async function atomicWriteFile(filePath: string, contents: string) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, contents, "utf8");
    // fsync via sync open/close to reduce truncated JSON risk on crash.
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function createFileLocalStorage(filePath: string): RuntimeStorage {
  let cache: Map<string, string> | null = null;

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(
      filePath,
      async () => {
        // Always reload under the lock so concurrent processes see latest data.
        cache = null;
        return fn();
      },
      { initialContents: "{}" },
    );
  }

  async function loadFresh(): Promise<Map<string, string>> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      cache = new Map(Object.entries(parsed));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        cache = new Map();
      } else if (error instanceof SyntaxError) {
        cache = new Map();
      } else {
        throw error;
      }
    }
    return cache as Map<string, string>;
  }

  async function flush(map: Map<string, string>) {
    const obj = Object.fromEntries(map.entries());
    await atomicWriteFile(filePath, `${JSON.stringify(obj, null, 2)}\n`);
  }

  return {
    async get(key) {
      return withLock(async () => {
        const map = await loadFresh();
        return map.get(key) ?? null;
      });
    },
    async set(key, value) {
      return withLock(async () => {
        const map = await loadFresh();
        map.set(key, value);
        await flush(map);
      });
    },
    async remove(key) {
      return withLock(async () => {
        const map = await loadFresh();
        map.delete(key);
        await flush(map);
      });
    },
    /**
     * Hold the cross-process file lock for the whole callback.
     *
     * Without this, a `load → modify → save` sequence takes the lock twice and
     * a second process can slip in between, so the later writer silently
     * overwrites the earlier one. Nested get/set reuse the same lock.
     */
    withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return withLock(fn);
    },
  };
}

/** Sync helper used in tests for atomic rename semantics. */
export function atomicWriteFileSync(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, filePath);
}
