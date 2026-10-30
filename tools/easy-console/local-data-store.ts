import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve, win32 } from "node:path";
import { homedir } from "node:os";

import lockfile from "proper-lockfile";

import type { RuntimeStorage } from "../../src/lib/types";

export function getDefaultLocalDataPath() {
  return process.env.EASY_CONSOLE_LOCAL_DATA_PATH || join(getTauriAppDataDir(), "runtime-storage.json");
}

export function getLegacyLocalDataPath(configPath: string) {
  return join(dirname(configPath), "local-data.json");
}

export function getDefaultCredentialDataPath(configPath: string) {
  return join(dirname(configPath), "credential-data.json");
}

export function getTauriAppDataDir(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const identifier = "com.easyconsole.desktop";
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), identifier);
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", identifier);
  const xdgDataHome = env.XDG_DATA_HOME;
  const base = xdgDataHome && posix.isAbsolute(xdgDataHome) ? xdgDataHome : posix.join(home, ".local", "share");
  return posix.join(base, identifier);
}

export function isCredentialStorageKey(key: string) {
  return key === "easy-console.token"
    || key === "easy-console.saved-accounts"
    || key.startsWith("easy-console.ssh.default-password:");
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
type FileLockState = { active: boolean; error?: Error };
const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, FileLockState>>();
const fileLockQueues = new Map<string, Promise<void>>();

async function withProcessFileQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLockQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  fileLockQueues.set(path, turn);
  await previous;
  try { return await fn(); } finally {
    release();
    if (fileLockQueues.get(path) === turn) fileLockQueues.delete(path);
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  // Lock the canonical target path without creating its data file: a blank
  // primary would hide an existing backup before migration can recover it.
  const canonicalPath = await realpath(filePath).catch(async (error: unknown) => {
    if (!isMissing(error)) throw error;
    return join(await realpath(dirname(filePath)), basename(filePath));
  });
  const held = heldLocks.getStore();
  const existing = held?.get(canonicalPath);
  if (existing) {
    if (!existing.active) throw new Error("The local storage transaction has already finished.");
    if (existing.error) throw existing.error;
    return fn();
  }
  // Same-process contenders wait in FIFO order instead of repeatedly probing
  // the same mkdir lock with exponential backoff. Reentrant calls bypass this.
  return withProcessFileQueue(canonicalPath, async () => {
    const state: FileLockState = { active: true };
    const release = await lockfile.lock(canonicalPath, {
      realpath: false,
      // Wait long enough to recover a crashed holder once its heartbeat is stale.
      retries: { retries: 80, factor: 1.5, minTimeout: 20, maxTimeout: 500 },
      stale: 30_000,
      update: 10_000,
      onCompromised: (error) => { state.error = error; },
    });
    const nested = new Map(held ?? []);
    nested.set(canonicalPath, state);
    try {
      const result = await heldLocks.run(nested, fn);
      if (state.error) throw state.error;
      return result;
    } finally {
      state.active = false;
      if (!state.error) await release();
    }
  });
}

function assertLocksHealthy() {
  for (const state of heldLocks.getStore()?.values() ?? []) {
    if (!state.active) throw new Error("The local storage transaction has already finished.");
    if (state.error) throw state.error;
  }
}

export async function atomicWriteFile(filePath: string, contents: string) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    assertLocksHealthy();
    await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    // fsync via sync open/close to reduce truncated JSON risk on crash.
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertLocksHealthy();
    await rename(tempPath, filePath);
    if (process.platform !== "win32") {
      const directoryFd = openSync(dirname(filePath), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export type FileLocalStorageOptions = {
  allowCredentialKeys?: boolean;
  migrationSource?: {
    filePath: string;
    includeKey?: (key: string) => boolean;
  };
};

function storeDirectory(filePath: string) {
  const extension = extname(filePath);
  const name = basename(filePath);
  return join(dirname(filePath), `${extension ? name.slice(0, -extension.length) : name}.d`);
}

function recordPath(filePath: string, key: string) {
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  return join(storeDirectory(filePath), `${hash}.json`);
}

function backupPath(filePath: string) {
  return `${filePath}.bak`;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function parseStringMap(raw: string, filePath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`Local data store is invalid JSON; preserve or restore the file before writing: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`Local data store has an invalid format; preserve or restore the file before writing: ${filePath}`);
  }
  return new Map(Object.entries(parsed as Record<string, string>));
}

async function readMapFile(filePath: string) {
  try {
    return parseStringMap(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readMapWithBackup(filePath: string) {
  const primaryExists = await pathExists(filePath);
  const backupExists = await pathExists(backupPath(filePath));
  if (!primaryExists && !backupExists) return new Map<string, string>();

  let primaryError: unknown;
  if (primaryExists) {
    try {
      const primary = await readMapFile(filePath);
      if (primary) return primary;
    } catch (error) {
      primaryError = error;
    }
  }
  if (backupExists) {
    try {
      const backup = await readMapFile(backupPath(filePath));
      if (backup) return backup;
    } catch {
      // Keep the primary error when neither snapshot is usable.
    }
  }
  throw primaryError ?? new Error(`Local data store is unreadable; preserve or restore the file: ${filePath}`);
}

async function writeStringMap(filePath: string, map: Map<string, string>) {
  const current = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  let currentIsValid = false;
  if (current !== null) {
    try {
      parseStringMap(current, filePath);
      currentIsValid = true;
    } catch { /* Keep the last good backup when recovering a damaged primary. */ }
  }
  if (currentIsValid && current !== null) await atomicWriteFile(backupPath(filePath), current);
  await atomicWriteFile(filePath, `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`);
}

export function createFileLocalStorage(filePath: string, options: FileLocalStorageOptions = {}): RuntimeStorage {
  const rootPath = resolve(filePath);
  const migrationSource = options.migrationSource
    ? { ...options.migrationSource, filePath: resolve(options.migrationSource.filePath) }
    : undefined;

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(rootPath, fn);
  }

  function assertKeyAllowed(key: string) {
    if (!options.allowCredentialKeys && isCredentialStorageKey(key)) {
      throw new Error(`Credential storage key must use the separate credential store: ${key}`);
    }
  }

  async function loadRecord(key: string) {
    const path = recordPath(rootPath, key);
    if (!await hasRecord(key)) return null;
    const record = await readMapWithBackup(path);
    if (record.get("key") !== key || [...record.keys()].some((field) => field !== "key" && field !== "value")) {
      throw new Error(`Local data entry is invalid; preserve or restore the file: ${path}`);
    }
    return record.get("value") ?? null;
  }

  async function hasRecord(key: string) {
    const path = recordPath(rootPath, key);
    return await pathExists(path) || await pathExists(backupPath(path));
  }

  async function persistRecord(key: string, value: string | null) {
    const record = new Map<string, string>([["key", key]]);
    if (value !== null) record.set("value", value);
    await mkdir(storeDirectory(rootPath), { recursive: true });
    await writeStringMap(recordPath(rootPath, key), record);
  }

  async function initializeStore() {
    const manifest = join(storeDirectory(rootPath), "manifest.json");
    const hasManifest = await pathExists(manifest) || await pathExists(backupPath(manifest));
    if (!hasManifest) {
      const legacy = await readMapWithBackup(rootPath);
      await mkdir(storeDirectory(rootPath), { recursive: true });
      for (const [key, value] of legacy) {
        // An explicit override may still point at the old CLI JSON itself.
        // Its credential copy is imported by the separate adapter below.
        if (!options.allowCredentialKeys && migrationSource?.filePath === rootPath && isCredentialStorageKey(key)) continue;
        if (await hasRecord(key)) {
          await loadRecord(key);
        } else {
          await persistRecord(key, value);
        }
      }
      const completion = new Map([["version", "1"]]);
      await writeStringMap(backupPath(manifest), completion);
      await writeStringMap(manifest, completion);
    } else {
      const parsed = await readMapWithBackup(manifest);
      if (parsed.size !== 1 || parsed.get("version") !== "1") {
        throw new Error(`Unrecognized local storage version; preserve the data and update the app: ${manifest}`);
      }
    }

    if (!migrationSource || migrationSource.filePath === rootPath) return;
    const sourceExists = await pathExists(migrationSource.filePath) || await pathExists(backupPath(migrationSource.filePath));
    if (!sourceExists) return;
    const markerHash = createHash("sha256").update(rootPath, "utf8").digest("hex").slice(0, 16);
    const marker = `${migrationSource.filePath}.shared-${markerHash}.done`;
    if (await pathExists(marker)) return;

    await withFileLock(migrationSource.filePath, async () => {
      const source = await readMapWithBackup(migrationSource.filePath);
      for (const [key, value] of source) {
        if (migrationSource.includeKey && !migrationSource.includeKey(key)) continue;
        if (await hasRecord(key)) {
          await loadRecord(key);
        } else {
          await persistRecord(key, value);
        }
      }
      await atomicWriteFile(marker, "1\n");
    });
  }

  return {
    async get(key) {
      assertKeyAllowed(key);
      return withLock(async () => {
        await initializeStore();
        return loadRecord(key);
      });
    },
    async set(key, value) {
      assertKeyAllowed(key);
      return withLock(async () => {
        await initializeStore();
        if (await loadRecord(key) !== value) await persistRecord(key, value);
      });
    },
    async remove(key) {
      assertKeyAllowed(key);
      return withLock(async () => {
        await initializeStore();
        if (await loadRecord(key) !== null) await persistRecord(key, null);
      });
    },
    async update(key, updater) {
      assertKeyAllowed(key);
      return withLock(async () => {
        await initializeStore();
        const current = await loadRecord(key);
        const next = await updater(current);
        if (next !== current) await persistRecord(key, next);
        return next;
      });
    },
    /**
     * Hold the cross-process file lock for the whole callback.
     *
     * The same lock target and `.lock` directory are used by the Tauri store.
     * Nested calls reuse the lock through AsyncLocalStorage.
     */
    withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return withLock(async () => {
        await initializeStore();
        return fn();
      });
    },
  };
}

export function createEasyConsoleLocalStorages(configPath: string) {
  const legacyPath = getLegacyLocalDataPath(configPath);
  const storagePath = getDefaultLocalDataPath();
  const credentialPath = getDefaultCredentialDataPath(configPath);
  if (resolve(storagePath) === resolve(credentialPath)) {
    throw new Error("The shared data path and the CLI credential data path must be different.");
  }
  return {
    storage: createFileLocalStorage(storagePath, {
      migrationSource: { filePath: legacyPath, includeKey: (key) => !isCredentialStorageKey(key) },
    }),
    credentialStorage: createFileLocalStorage(credentialPath, {
      allowCredentialKeys: true,
      migrationSource: { filePath: legacyPath, includeKey: isCredentialStorageKey },
    }),
    storagePath,
  };
}

/** Sync helper used in tests for atomic rename semantics. */
export function atomicWriteFileSync(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, filePath);
}
