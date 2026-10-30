// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { updateStorageValue } from "../../src/lib/storage-mutex";

import {
  atomicWriteFileSync,
  createEasyConsoleLocalStorages,
  createFileLocalStorage,
  getTauriAppDataDir,
  isCredentialStorageKey,
} from "./local-data-store";

const testDirectories: string[] = [];
async function testDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of testDirectories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

function recordPath(filePath: string, key: string) {
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  const directory = filePath.replace(/\.json$/i, ".d");
  return join(directory, `${hash}.json`);
}

describe("local-data-store", () => {
  it("persists values in the Tauri-compatible per-key format and reloads under lock", async () => {
    const dir = await testDirectory("easy-console-local-");
    const filePath = join(dir, "local-data.json");
    const storage = createFileLocalStorage(filePath);

    await storage.set("a", "1");
    await storage.set("b", "2");
    expect(await storage.get("a")).toBe("1");
    expect(await storage.get("b")).toBe("2");

    expect(JSON.parse(await readFile(recordPath(filePath, "a"), "utf8"))).toEqual({ key: "a", value: "1" });
    expect(JSON.parse(await readFile(join(filePath.replace(/\.json$/i, ".d"), "manifest.json"), "utf8"))).toEqual({ version: "1" });
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await storage.remove("a");
    expect(await storage.get("a")).toBeNull();
  });

  it("preserves malformed stores and rejects reads and writes", async () => {
    const dir = await testDirectory("easy-console-corrupt-local-");
    const filePath = join(dir, "local-data.json");
    const damaged = '{"templates":';
    await writeFile(filePath, damaged, "utf8");
    const storage = createFileLocalStorage(filePath);

    await expect(storage.get("templates")).rejects.toThrow(/invalid JSON/);
    await expect(storage.set("templates", "[]")).rejects.toThrow(/invalid JSON/);
    expect(await readFile(filePath, "utf8")).toBe(damaged);
  });

  it("rejects valid JSON with a shape that cannot be a local store", async () => {
    const dir = await testDirectory("easy-console-invalid-local-");
    const filePath = join(dir, "local-data.json");
    const invalid = '["unexpected"]';
    await writeFile(filePath, invalid, "utf8");
    const storage = createFileLocalStorage(filePath);

    await expect(storage.get("templates")).rejects.toThrow(/invalid format/);
    await expect(storage.set("templates", "[]")).rejects.toThrow(/invalid format/);
    expect(await readFile(filePath, "utf8")).toBe(invalid);
  });

  it("atomicWriteFileSync replaces the target via temp rename", async () => {
    const dir = await testDirectory("easy-console-atomic-");
    const filePath = join(dir, "data.json");
    atomicWriteFileSync(filePath, '{"ok":true}');
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ok: true });
    atomicWriteFileSync(filePath, '{"ok":false}');
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ok: false });
  });

  it("allows get/set nested inside withTransaction without deadlocking", async () => {
    const dir = await testDirectory("easy-console-reentrant-");
    const storage = createFileLocalStorage(join(dir, "local-data.json"));

    // proper-lockfile is not reentrant, so this would hang if the nested calls
    // tried to take the lock again instead of reusing the held one.
    const result = await storage.withTransaction!(async () => {
      const before = await storage.get("counter");
      const next = String(Number(before ?? "0") + 1);
      await storage.set("counter", next);
      return next;
    });

    expect(result).toBe("1");
    expect(await storage.get("counter")).toBe("1");
  });

  it("serializes concurrent read-modify-write so no update is lost", async () => {
    const dir = await testDirectory("easy-console-concurrent-");
    const filePath = join(dir, "local-data.json");
    // Separate store instances stand in for separate processes: they share the
    // file and the on-disk lock, but no in-memory state.
    const stores = Array.from({ length: 8 }, () => createFileLocalStorage(filePath));

    await stores[0]!.set("items", JSON.stringify([]));

    await Promise.all(
      stores.map((storage, index) =>
        storage.withTransaction!(async () => {
          const raw = await storage.get("items");
          const items = JSON.parse(raw ?? "[]") as number[];
          items.push(index);
          await storage.set("items", JSON.stringify(items));
        }),
      ),
    );

    const items = JSON.parse((await stores[0]!.get("items")) ?? "[]") as number[];
    expect(items.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("does not deadlock a transaction that updates a key while another updater waits for the file lock", async () => {
    const dir = await testDirectory("easy-console-lock-order-");
    const storage = createFileLocalStorage(join(dir, "runtime-storage.json"));
    let entered!: () => void;
    const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const continueTransaction = new Promise<void>((resolve) => { release = resolve; });
    const increment = (raw: string | null) => String(Number(raw ?? "0") + 1);
    const transaction = storage.withTransaction!(async () => {
      entered();
      await continueTransaction;
      await updateStorageValue(storage, "counter", increment);
    });
    await transactionEntered;
    const concurrent = updateStorageValue(storage, "counter", increment);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([transaction, concurrent]);
    expect(await storage.get("counter")).toBe("2");
  });

  it("imports legacy CLI data without replacing desktop values or moving credentials", async () => {
    const dir = await testDirectory("easy-console-share-migration-");
    const desktopPath = join(dir, "runtime-storage.json");
    const legacyPath = join(dir, ".easy-console", "local-data.json");
    await mkdir(join(dir, ".easy-console"), { recursive: true });
    await writeFile(desktopPath, JSON.stringify({ shared: "desktop", removed: "" }), "utf8");
    await writeFile(legacyPath, JSON.stringify({ shared: "cli", imported: "from-cli", "easy-console.token": "secret" }), "utf8");
    const legacySnapshot = await readFile(legacyPath, "utf8");
    const storage = createFileLocalStorage(desktopPath, {
      migrationSource: { filePath: legacyPath, includeKey: (key) => !isCredentialStorageKey(key) },
    });

    expect(await storage.get("shared")).toBe("desktop");
    expect(await storage.get("imported")).toBe("from-cli");
    await expect(storage.get("easy-console.token")).rejects.toThrow(/separate credential store/);
    expect(await readFile(legacyPath, "utf8")).toBe(legacySnapshot);
    expect(await readFile(`${legacyPath}.shared-${createHash("sha256").update(desktopPath).digest("hex").slice(0, 16)}.done`, "utf8")).toBe("1\n");
  });

  it("keeps credential keys in the separate local credential store", async () => {
    const dir = await testDirectory("easy-console-credential-store-");
    const configPath = join(dir, "config.json");
    const legacyPath = join(dir, "local-data.json");
    await writeFile(legacyPath, JSON.stringify({ "easy-console.token": "token", "easy-console.saved-accounts": "[]" }), "utf8");
    vi.stubEnv("EASY_CONSOLE_LOCAL_DATA_PATH", join(dir, "desktop-runtime.json"));
    const stores = createEasyConsoleLocalStorages(configPath);

    expect(await stores.credentialStorage.get("easy-console.token")).toBe("token");
    expect(await stores.credentialStorage.get("easy-console.saved-accounts")).toBe("[]");
    expect(await stores.storage.get("normal")).toBeNull();
    await expect(stores.storage.set("easy-console.token", "new-token")).rejects.toThrow(/separate credential store/);
    await expect(readFile(recordPath(stores.storagePath, "easy-console.token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a missing legacy primary from its backup without creating an empty replacement", async () => {
    const dir = await testDirectory("easy-console-missing-primary-");
    const path = join(dir, "runtime-storage.json");
    await writeFile(`${path}.bak`, JSON.stringify({ key: "preserved" }));
    const storage = createFileLocalStorage(path);
    expect(await storage.get("key")).toBe("preserved");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual({ key: "preserved" });
  });

  it.each(["corrupt", "missing"])("recovers a %s record from its backup and preserves the backup on the next write", async (failure) => {
    const dir = await testDirectory("easy-console-record-recovery-");
    const path = join(dir, "runtime-storage.json");
    const storage = createFileLocalStorage(path);
    await storage.set("key", "backup");
    await storage.set("key", "latest");
    const record = recordPath(path, "key");
    if (failure === "corrupt") await writeFile(record, "broken JSON");
    else await unlink(record);
    expect(await storage.get("key")).toBe("backup");
    await storage.set("key", "recovered");
    expect(await storage.get("key")).toBe("recovered");
    expect(JSON.parse(await readFile(`${record}.bak`, "utf8"))).toEqual({ key: "key", value: "backup" });
  });

  it("rejects a record with the wrong key instead of overwriting it", async () => {
    const dir = await testDirectory("easy-console-wrong-key-");
    const path = join(dir, "runtime-storage.json");
    const storage = createFileLocalStorage(path);
    await storage.set("key", "value");
    const damaged = JSON.stringify({ key: "other", value: "wrong" });
    await writeFile(recordPath(path, "key"), damaged);
    await expect(storage.get("key")).rejects.toThrow(/entry is invalid/);
    await expect(storage.set("key", "new")).rejects.toThrow(/entry is invalid/);
    expect(await readFile(recordPath(path, "key"), "utf8")).toBe(damaged);
  });

  it("resumes an interrupted migration without reviving a tombstone or replacing a newer record", async () => {
    const dir = await testDirectory("easy-console-interrupted-migration-");
    const path = join(dir, "runtime-storage.json");
    const snapshot = JSON.stringify({ removed: "old", changed: "old", remaining: "old" });
    await writeFile(path, snapshot);
    await mkdir(join(dir, "runtime-storage.d"));
    await writeFile(recordPath(path, "removed"), JSON.stringify({ key: "removed" }));
    await writeFile(recordPath(path, "changed"), JSON.stringify({ key: "changed", value: "new" }));
    const storage = createFileLocalStorage(path);
    expect(await storage.get("removed")).toBeNull();
    expect(await storage.get("changed")).toBe("new");
    expect(await storage.get("remaining")).toBe("old");
    expect(await readFile(path, "utf8")).toBe(snapshot);
    await storage.remove("remaining");
    const reopened = createFileLocalStorage(path);
    expect(await reopened.get("remaining")).toBeNull();
  });

  it("rejects unknown manifest versions without rewriting any record", async () => {
    const dir = await testDirectory("easy-console-newer-store-");
    const path = join(dir, "runtime-storage.json");
    const storage = createFileLocalStorage(path);
    await storage.set("key", "value");
    await writeFile(join(dir, "runtime-storage.d", "manifest.json"), JSON.stringify({ version: "99" }));
    await expect(storage.set("key", "new")).rejects.toThrow(/Unrecognized local storage version/);
    expect(JSON.parse(await readFile(recordPath(path, "key"), "utf8"))).toEqual({ key: "key", value: "value" });
  });

  it("resolves the same Tauri application data directory on each platform", () => {
    expect(getTauriAppDataDir("win32", { APPDATA: "C:/Users/test/AppData/Roaming" } as NodeJS.ProcessEnv, "C:/Users/test"))
      .toBe(win32.join("C:/Users/test/AppData/Roaming", "com.easyconsole.desktop"));
    expect(getTauriAppDataDir("darwin", {} as NodeJS.ProcessEnv, "/Users/test"))
      .toBe(posix.join("/Users/test", "Library", "Application Support", "com.easyconsole.desktop"));
    expect(getTauriAppDataDir("linux", { XDG_DATA_HOME: "/home/test/data" } as NodeJS.ProcessEnv, "/home/test"))
      .toBe(posix.join("/home/test/data", "com.easyconsole.desktop"));
    expect(getTauriAppDataDir("linux", { XDG_DATA_HOME: "relative" } as NodeJS.ProcessEnv, "/home/test"))
      .toBe(posix.join("/home/test", ".local", "share", "com.easyconsole.desktop"));
  });
});
