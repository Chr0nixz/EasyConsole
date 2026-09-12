import { afterEach, describe, expect, it } from "vitest";

import { decryptBackup, encryptBackup, isEncryptedBackup } from "./backup-crypto";
import { setActiveLocale } from "./i18n-text";
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
  // The message language follows the module-level locale, so restore it even
  // when an assertion above throws.
  afterEach(() => {
    setActiveLocale("zh-CN");
  });

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
    setActiveLocale("en-US");
    await expect(decryptBackup(encrypted, "wrong-password")).rejects.toThrow(/Decryption failed/);
    setActiveLocale("zh-CN");
    await expect(decryptBackup(encrypted, "wrong-password")).rejects.toThrow(/解密失败/);
  });

  it("detects encrypted backup format", () => {
    expect(isEncryptedBackup({ app: "EasyConsole", encrypted: true })).toBe(true);
    expect(isEncryptedBackup({ app: "EasyConsole" })).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });

  it("rejects empty password for encryption", async () => {
    setActiveLocale("en-US");
    await expect(encryptBackup(sampleBackup, "")).rejects.toThrow(/Password is required/);
    setActiveLocale("zh-CN");
    await expect(encryptBackup(sampleBackup, "")).rejects.toThrow(/加密需要提供密码/);
  });
});
