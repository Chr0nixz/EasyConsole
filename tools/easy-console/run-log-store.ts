import { createHash } from "node:crypto";
import { access, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RuntimeStorage } from "../../src/lib/types";
import { parseRunLogs, pruneRunLogs, RUN_LOGS_STORAGE_KEY } from "../../src/lib/run-logs";
import { atomicWriteFile, withFileLock } from "./local-data-store";

export function getDefaultRunLogPath(configPath: string) {
  return process.env.EASY_CONSOLE_RUN_LOG_PATH || join(dirname(configPath), "run-logs.json");
}

/** Copy the old sidecar log file once, merging ids and keeping its snapshot. */
export async function migrateLegacyRunLogs(storage: RuntimeStorage, storagePath: string, legacyLogPath: string) {
  const isMissing = (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  try { await access(legacyLogPath); } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const targetHash = createHash("sha256").update(resolve(storagePath)).digest("hex").slice(0, 16);
  const marker = `${legacyLogPath}.shared-${targetHash}.done`;
  const migrate = async () => withFileLock(legacyLogPath, async () => {
    try { await access(marker); return; } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const raw = await readFile(legacyLogPath, "utf8");
    if (!Array.isArray(JSON.parse(raw))) throw new Error(`Legacy run logs must be a JSON array: ${legacyLogPath}`);
    const byId = new Map(parseRunLogs(raw).map((entry) => [entry.id, entry]));
    for (const entry of parseRunLogs(await storage.get(RUN_LOGS_STORAGE_KEY))) byId.set(entry.id, entry);
    await storage.set(RUN_LOGS_STORAGE_KEY, JSON.stringify(pruneRunLogs([...byId.values()])));
    await atomicWriteFile(marker, "1\n");
  });
  if (storage.withTransaction) await storage.withTransaction(migrate);
  else await migrate();
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
