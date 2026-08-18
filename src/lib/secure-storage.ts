import type { RuntimeStorage } from "./types";

/**
 * Layered secure storage: prefer an OS keychain backend, fall back to a local
 * durable store when keychain is unavailable or rejects the value (e.g. Windows
 * Credential Manager's ~2560-byte blob limit).
 *
 * Critical invariants:
 * - get() must check the fallback when keychain returns null/empty, not only on
 *   thrown errors. Otherwise a failed keychain write that fell back to local
 *   storage is invisible on the next read.
 * - remove() must clear both backends.
 * - set() only drops the fallback copy after a verified keychain write.
 */
export function createLayeredSecureStorage(
  keychain: RuntimeStorage,
  fallback: RuntimeStorage,
): RuntimeStorage {
  return {
    async get(key) {
      try {
        const value = await keychain.get(key);
        if (value != null && value !== "") return value;
      } catch (error) {
        console.warn("Keychain get failed, falling back to local secure storage.", error);
      }
      return fallback.get(key);
    },
    async set(key, value) {
      try {
        await keychain.set(key, value);
        try {
          const verified = await keychain.get(key);
          if (verified === value) {
            await fallback.remove(key).catch(() => undefined);
            return;
          }
        } catch {
          // Verification failed — keep writing to fallback below.
        }
      } catch (error) {
        console.warn("Keychain set failed, falling back to local secure storage.", error);
      }
      await fallback.set(key, value);
    },
    async remove(key) {
      const results = await Promise.allSettled([keychain.remove(key), fallback.remove(key)]);
      const keychainRejected = results[0].status === "rejected";
      const fallbackRejected = results[1].status === "rejected";
      if (keychainRejected && fallbackRejected) {
        const reason = results[0].status === "rejected" ? results[0].reason : results[1];
        throw reason instanceof Error ? reason : new Error(String(reason));
      }
      if (keychainRejected) {
        console.warn(
          "Keychain remove failed; fallback copy was cleared.",
          results[0].status === "rejected" ? results[0].reason : undefined,
        );
      }
    },
  };
}

/**
 * Copy a plaintext key into secure storage when secure storage does not already
 * have it. Never deletes the plaintext copy: on platforms where secure storage
 * falls back to the same plaintext backend, deleting would destroy the only
 * copy (the previous Windows restart bug).
 */
export async function migrateKeyToSecureStorage(
  plaintext: RuntimeStorage,
  secure: RuntimeStorage,
  key: string,
): Promise<void> {
  const existing = await secure.get(key);
  if (existing) return;

  const raw = await plaintext.get(key);
  if (!raw) return;

  await secure.set(key, raw);
}
