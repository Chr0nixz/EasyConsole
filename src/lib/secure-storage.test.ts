import { describe, expect, it, vi } from "vitest";

import { createLayeredSecureStorage, migrateKeyToSecureStorage } from "./secure-storage";
import type { RuntimeStorage } from "./types";

function createMemoryStorage(initial: Record<string, string> = {}): RuntimeStorage {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

describe("createLayeredSecureStorage", () => {
  it("reads from fallback when keychain returns null", async () => {
    const keychain = createMemoryStorage();
    const fallback = createMemoryStorage({ token: "from-fallback" });
    const secure = createLayeredSecureStorage(keychain, fallback);

    expect(await secure.get("token")).toBe("from-fallback");
  });

  it("writes to fallback when keychain set fails", async () => {
    const keychain: RuntimeStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("blob too large");
      },
      async remove() {},
    };
    const fallback = createMemoryStorage();
    const secure = createLayeredSecureStorage(keychain, fallback);

    await secure.set("accounts", "[{\"id\":\"1\"}]");
    expect(await fallback.get("accounts")).toBe("[{\"id\":\"1\"}]");
    expect(await secure.get("accounts")).toBe("[{\"id\":\"1\"}]");
  });

  it("keeps fallback readable across a migrate-then-restart cycle when keychain is down", async () => {
    const keychain: RuntimeStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("keychain unavailable");
      },
      async remove() {},
    };
    const plaintext = createMemoryStorage({ "easy-console.token": "Bearer abc" });
    const secure = createLayeredSecureStorage(keychain, plaintext);

    await migrateKeyToSecureStorage(plaintext, secure, "easy-console.token");
    // Simulate app restart: new layered adapter over the same plaintext store.
    const secureAfterRestart = createLayeredSecureStorage(keychain, plaintext);
    expect(await secureAfterRestart.get("easy-console.token")).toBe("Bearer abc");
  });

  it("does not delete plaintext during migration when secure falls back to the same store", async () => {
    const keychain: RuntimeStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("keychain unavailable");
      },
      async remove() {},
    };
    const plaintext = createMemoryStorage({ "easy-console.saved-accounts": "[]" });
    const secure = createLayeredSecureStorage(keychain, plaintext);

    await migrateKeyToSecureStorage(plaintext, secure, "easy-console.saved-accounts");
    expect(await plaintext.get("easy-console.saved-accounts")).toBe("[]");
  });

  it("removes from both backends", async () => {
    const keychain = createMemoryStorage({ token: "kc" });
    const fallback = createMemoryStorage({ token: "fb" });
    const secure = createLayeredSecureStorage(keychain, fallback);

    await secure.remove("token");
    expect(await keychain.get("token")).toBeNull();
    expect(await fallback.get("token")).toBeNull();
  });

  it("drops fallback copy after a verified keychain write", async () => {
    const keychain = createMemoryStorage();
    const fallback = createMemoryStorage({ token: "stale" });
    const secure = createLayeredSecureStorage(keychain, fallback);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await secure.set("token", "fresh");
    expect(await keychain.get("token")).toBe("fresh");
    expect(await fallback.get("token")).toBeNull();
    expect(await secure.get("token")).toBe("fresh");

    warn.mockRestore();
  });
});
