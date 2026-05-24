import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeStorage } from "../../src/lib/types";
import { RUN_LOGS_STORAGE_KEY } from "../../src/lib/run-logs";

export function getDefaultRunLogPath(configPath: string) {
  return process.env.EASY_CONSOLE_RUN_LOG_PATH ?? join(dirname(configPath), "run-logs.json");
}

export function createFileRunLogStorage(runLogPath: string): RuntimeStorage {
  return {
    async get(key) {
      if (key !== RUN_LOGS_STORAGE_KEY) return null;
      try {
        return await readFile(runLogPath, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async set(key, value) {
      if (key !== RUN_LOGS_STORAGE_KEY) return;
      await mkdir(dirname(runLogPath), { recursive: true });
      await writeFile(runLogPath, `${value}\n`, "utf8");
    },
    async remove(key) {
      if (key !== RUN_LOGS_STORAGE_KEY) return;
      await this.set(key, "[]");
    },
  };
}
