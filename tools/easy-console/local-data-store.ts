import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import type { RuntimeStorage } from "../../src/lib/types";

export function getDefaultLocalDataPath(configPath: string) {
  return process.env.EASY_CONSOLE_LOCAL_DATA_PATH ?? join(dirname(configPath), "local-data.json");
}

async function atomicWriteFile(filePath: string, contents: string) {
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

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(filePath), { recursive: true });
    // Ensure the target exists so proper-lockfile can lock it.
    try {
      await writeFile(filePath, "{}", { flag: "wx" });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        // ignore non-EEXIST; lock will surface real errors
      }
    }
    const release = await lockfile.lock(filePath, {
      retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 200 },
      stale: 30_000,
    });
    try {
      // Always reload under the lock so concurrent processes see latest data.
      cache = null;
      return await fn();
    } finally {
      await release();
    }
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
  };
}

/** Sync helper used in tests for atomic rename semantics. */
export function atomicWriteFileSync(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, filePath);
}
