import { describe, expect, it } from "vitest";

import { decryptBackup, encryptBackup, isEncryptedBackup } from "./backup-crypto";
import type { LocalDataBackup } from "./local-data-backup";

const sampleBackup: LocalDataBackup = {
  app: "EasyConsole",
  version: 1,
  exportedAt: "2026-06-26T12:00:00.000Z",
  includeSecrets: false,
  items: {
    language: "zh-CN",
    taskTemplates: [{ id: "tpl-1", name: "dev" }],
  },
};

describe("backup-crypto", () => {
  it("encrypts and decrypts a backup round-trip", async () => {
    const encrypted = await encryptBackup(sampleBackup, "my-password");
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.cipher.ciphertext).toBeTruthy();
    expect(encrypted.kdf.salt).toBeTruthy();
    expect(encrypted.cipher.iv).toBeTruthy();

    const decrypted = await decryptBackup(encrypted, "my-password");
    expect(decrypted).toEqual(sampleBackup);
  });

  it("fails decryption with the wrong password", async () => {
    const encrypted = await encryptBackup(sampleBackup, "correct-password");
    await expect(decryptBackup(encrypted, "wrong-password")).rejects.toThrow(/Decryption failed/);
  });

  it("detects encrypted backup format", () => {
    expect(isEncryptedBackup({ app: "EasyConsole", encrypted: true })).toBe(true);
    expect(isEncryptedBackup({ app: "EasyConsole" })).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });

  it("rejects empty password for encryption", async () => {
    await expect(encryptBackup(sampleBackup, "")).rejects.toThrow(/Password is required/);
  });
});
