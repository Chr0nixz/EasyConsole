import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { atomicWriteFileSync, createFileLocalStorage } from "./local-data-store";

describe("local-data-store", () => {
  it("persists values atomically and reloads under lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-local-"));
    const filePath = join(dir, "local-data.json");
    const storage = createFileLocalStorage(filePath);

    await storage.set("a", "1");
    await storage.set("b", "2");
    expect(await storage.get("a")).toBe("1");
    expect(await storage.get("b")).toBe("2");

    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ a: "1", b: "2" });

    await storage.remove("a");
    expect(await storage.get("a")).toBeNull();
  });

  it("atomicWriteFileSync replaces the target via temp rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-atomic-"));
    const filePath = join(dir, "data.json");
    atomicWriteFileSync(filePath, '{"ok":true}');
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ok: true });
    atomicWriteFileSync(filePath, '{"ok":false}');
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ ok: false });
  });

  it("allows get/set nested inside withTransaction without deadlocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "easy-console-reentrant-"));
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
    const dir = await mkdtemp(join(tmpdir(), "easy-console-concurrent-"));
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

    const items = JSON.parse(JSON.parse(await readFile(filePath, "utf8")).items as string) as number[];
    expect(items.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
