import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RuntimeStorage } from "../../src/lib/types";
import { RUN_LOGS_STORAGE_KEY } from "../../src/lib/run-logs";
import { atomicWriteFile, withFileLock } from "./local-data-store";

export function getDefaultRunLogPath(configPath: string) {
  return process.env.EASY_CONSOLE_RUN_LOG_PATH ?? join(dirname(configPath), "run-logs.json");
}

/**
 * Run logs are appended by every CLI command and MCP tool call, so the CLI and
 * the MCP sidecar routinely write this file at the same time. A plain
 * `writeFile` there is doubly unsafe: concurrent writers overwrite each other,
 * and an interrupted write leaves truncated JSON that `parseRunLogs` silently
 * turns into an empty list -- losing the entire audit trail without any error.
 */
export function createFileRunLogStorage(runLogPath: string): RuntimeStorage {
  async function readRaw() {
    try {
      return await readFile(runLogPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async get(key) {
      if (key !== RUN_LOGS_STORAGE_KEY) return null;
      return withFileLock(runLogPath, async () => {
        const raw = await readRaw();
        if (raw === null) return null;
        try {
          JSON.parse(raw);
          return raw;
        } catch {
          // Keep the damaged file for inspection instead of letting the caller
          // silently start from an empty log.
          await rename(runLogPath, `${runLogPath}.corrupt`).catch(() => undefined);
          return null;
        }
      });
    },
    async set(key, value) {
      if (key !== RUN_LOGS_STORAGE_KEY) return;
      await withFileLock(runLogPath, () => atomicWriteFile(runLogPath, `${value}\n`));
    },
    async remove(key) {
      if (key !== RUN_LOGS_STORAGE_KEY) return;
      await withFileLock(runLogPath, () => atomicWriteFile(runLogPath, "[]\n"));
    },
    withTransaction(fn) {
      return withFileLock(runLogPath, fn);
    },
  };
}
