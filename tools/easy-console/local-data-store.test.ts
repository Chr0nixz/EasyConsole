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
});
