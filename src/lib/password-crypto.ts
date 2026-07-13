// Local obfuscation-grade encryption for saved passwords.
//
// On Tauri, secureStorage already uses the OS keychain (macOS Keychain,
// Windows Credential Manager, Linux Secret Service), so ciphertext at rest is
// already protected by the OS. On the web build, secureStorage falls back to
// localStorage, which is readable by any script with same-origin access.
//
// This module provides AES-GCM encryption with a per-account random salt and a
// fixed app-derived key. It is NOT a strong boundary on the web build — anyone
// who can read localStorage can also read this source and reproduce the key —
// but it raises the bar above plaintext and avoids storing human-readable
// passwords in devtools.

const PBKDF2_ITERATIONS = 150_000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_KEY_LENGTH = 256;

// Fixed app-specific input mixed into the KDF. This is not secret — its only
// job is to ensure that ciphertext from another app's localStorage cannot be
// decrypted by reusing the same browser-wide password string.
const APP_KDF_INPUT = "EasyConsole.saved-account.password.v1";

const subtle = globalThis.crypto?.subtle;
const rootCrypto = globalThis.crypto;

export type EncryptedPassword = {
  algorithm: "AES-GCM";
  kdf: {
    algorithm: "PBKDF2";
    hash: typeof PBKDF2_HASH;
    iterations: number;
    salt: string;
  };
  iv: string;
  ciphertext: string;
};

function assertSubtle() {
  if (!subtle) {
    throw new Error("Web Crypto API is not available in this environment");
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const crypto = assertSubtle();
  const encoder = new TextEncoder();
  const baseKey = await crypto.importKey(
    "raw",
    asBufferSource(encoder.encode(APP_KDF_INPUT)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.deriveKey(
    { name: "PBKDF2", hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS, salt: asBufferSource(salt) },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("Password is required for encryption");
  if (!rootCrypto) throw new Error("Web Crypto API is not available in this environment");
  const crypto = assertSubtle();
  const encoder = new TextEncoder();
  const salt = rootCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = rootCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(salt);
  const ciphertext = await crypto.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    key,
    asBufferSource(encoder.encode(plaintext)),
  );
  const payload: EncryptedPassword = {
    algorithm: "AES-GCM",
    kdf: {
      algorithm: "PBKDF2",
      hash: PBKDF2_HASH,
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(payload);
}

export async function decryptPassword(stored: string): Promise<string> {
  if (!stored) throw new Error("Encrypted password payload is empty");
  const crypto = assertSubtle();
  const decoder = new TextDecoder();
  let payload: EncryptedPassword;
  try {
    payload = JSON.parse(stored) as EncryptedPassword;
  } catch {
    throw new Error("Encrypted password payload is corrupted");
  }
  if (payload.algorithm !== "AES-GCM" || !payload.kdf || !payload.iv || !payload.ciphertext) {
    throw new Error("Encrypted password payload is malformed");
  }
  const salt = base64ToBytes(payload.kdf.salt);
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const key = await deriveKey(salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.decrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, asBufferSource(ciphertext));
  } catch {
    throw new Error("Password decryption failed");
  }
  return decoder.decode(plaintext);
}

export function isEncryptedPasswordPayload(value: unknown): value is EncryptedPassword {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.algorithm === "AES-GCM" &&
    Boolean(record.kdf) &&
    typeof record.iv === "string" &&
    typeof record.ciphertext === "string"
  );
}
