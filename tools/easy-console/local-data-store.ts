import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeStorage } from "../../src/lib/types";

export function getDefaultLocalDataPath(configPath: string) {
  return process.env.EASY_CONSOLE_LOCAL_DATA_PATH ?? join(dirname(configPath), "local-data.json");
}

export function createFileLocalStorage(filePath: string): RuntimeStorage {
  let cache: Map<string, string> | null = null;

  async function load(): Promise<Map<string, string>> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      cache = new Map(Object.entries(parsed));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        cache = new Map();
      } else {
        throw error;
      }
    }
    return cache as Map<string, string>;
  }

  async function flush(map: Map<string, string>) {
    await mkdir(dirname(filePath), { recursive: true });
    const obj = Object.fromEntries(map.entries());
    await writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
  }

  return {
    async get(key) {
      const map = await load();
      return map.get(key) ?? null;
    },
    async set(key, value) {
      const map = await load();
      map.set(key, value);
      await flush(map);
    },
    async remove(key) {
      const map = await load();
      map.delete(key);
      await flush(map);
    },
  };
}
