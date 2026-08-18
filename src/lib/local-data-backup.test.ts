import { describe, expect, it } from "vitest";

import { TOKEN_STORAGE_KEY } from "./api-client";
import { exportLocalDataBackup, importLocalDataBackup, secretBackupSections } from "./local-data-backup";
import { SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts } from "./saved-accounts";
import type { RuntimeStorage } from "./types";

function createMemoryStorage(initial: Record<string, string> = {}): RuntimeStorage {
  const data = new Map(Object.entries(initial));
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

describe("local-data-backup credentials", () => {
  it("reads and writes secrets from credentialStorage, not ordinary storage", async () => {
    const storage = createMemoryStorage();
    const credentialStorage = createMemoryStorage({
      [TOKEN_STORAGE_KEY]: "Bearer secret-token",
      [SAVED_ACCOUNTS_STORAGE_KEY]: stringifySavedAccounts([
        {
          id: "alice",
          username: "alice",
          displayName: "Alice",
          token: "Bearer secret-token",
          lastLoginAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });

    const exported = await exportLocalDataBackup({ storage, credentialStorage }, true);
    expect(exported.includeSecrets).toBe(true);
    expect(exported.items.token).toBe("Bearer secret-token");
    expect(exported.items.savedAccounts).toHaveLength(1);

    const targetStorage = createMemoryStorage();
    const targetCredentials = createMemoryStorage();
    await importLocalDataBackup({ storage: targetStorage, credentialStorage: targetCredentials }, exported, [
      ...secretBackupSections,
    ]);

    expect(await targetStorage.get(TOKEN_STORAGE_KEY)).toBeNull();
    expect(await targetCredentials.get(TOKEN_STORAGE_KEY)).toBe("Bearer secret-token");
    expect(await targetCredentials.get(SAVED_ACCOUNTS_STORAGE_KEY)).toContain("alice");
  });

  it("omits secrets when includeSecrets is false", async () => {
    const credentialStorage = createMemoryStorage({
      [TOKEN_STORAGE_KEY]: "Bearer secret-token",
    });
    const exported = await exportLocalDataBackup({ storage: createMemoryStorage(), credentialStorage }, false);
    expect(exported.items.token).toBeUndefined();
    expect(exported.items.savedAccounts).toBeUndefined();
  });
});
