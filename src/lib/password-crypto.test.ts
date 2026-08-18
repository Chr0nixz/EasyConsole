import { describe, expect, it } from "vitest";

import { decryptPassword, encryptPassword, isEncryptedPasswordPayload } from "./password-crypto";

describe("password-crypto", () => {
  it("encrypts and decrypts a password round-trip", async () => {
    const encrypted = await encryptPassword("hunter2");
    expect(encrypted).not.toContain("hunter2");

    const decrypted = await decryptPassword(encrypted);
    expect(decrypted).toBe("hunter2");
  });

  it("produces different ciphertexts for the same plaintext (random salt/iv)", async () => {
    const a = await encryptPassword("same-password");
    const b = await encryptPassword("same-password");
    expect(a).not.toBe(b);
    expect(await decryptPassword(a)).toBe("same-password");
    expect(await decryptPassword(b)).toBe("same-password");
  });

  it("supports unicode passwords", async () => {
    const encrypted = await encryptPassword("密码123🔐");
    expect(await decryptPassword(encrypted)).toBe("密码123🔐");
  });

  it("rejects empty plaintext for encryption", async () => {
    await expect(encryptPassword("")).rejects.toThrow(/Password is required/);
  });

  it("rejects empty payload for decryption", async () => {
    await expect(decryptPassword("")).rejects.toThrow(/payload is empty/);
  });

  it("rejects corrupted JSON payload", async () => {
    await expect(decryptPassword("{not json")).rejects.toThrow(/corrupted/);
  });

  it("rejects malformed payload structure", async () => {
    const malformed = JSON.stringify({ algorithm: "AES-GCM", iv: "x", ciphertext: "y" });
    await expect(decryptPassword(malformed)).rejects.toThrow(/malformed/);
  });

  it("detects encrypted password payload shape", () => {
    const valid = {
      algorithm: "AES-GCM",
      kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "s" },
      iv: "i",
      ciphertext: "c",
    };
    expect(isEncryptedPasswordPayload(valid)).toBe(true);
    expect(isEncryptedPasswordPayload({ algorithm: "AES-GCM" })).toBe(false);
    expect(isEncryptedPasswordPayload(null)).toBe(false);
  });
});
