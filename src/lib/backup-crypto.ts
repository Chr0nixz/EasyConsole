import type { LocalDataBackup } from "./local-data-backup";

const PBKDF2_ITERATIONS = 150_000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_KEY_LENGTH = 256;

export type EncryptedBackup = {
  app: "EasyConsole";
  encrypted: true;
  version: 1;
  exportedAt: string;
  kdf: {
    algorithm: "PBKDF2";
    hash: typeof PBKDF2_HASH;
    iterations: number;
    salt: string;
  };
  cipher: {
    algorithm: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
};

const subtle = globalThis.crypto?.subtle;
const rootCrypto = globalThis.crypto;

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

/** Casts a Uint8Array to BufferSource for Web Crypto APIs that require ArrayBuffer-backed views. */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const crypto = assertSubtle();
  const encoder = new TextEncoder();
  const baseKey = await crypto.importKey("raw", asBufferSource(encoder.encode(password)), "PBKDF2", false, ["deriveKey"]);
  return crypto.deriveKey(
    { name: "PBKDF2", hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS, salt: asBufferSource(salt) },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncryptedBackup(value: unknown): value is EncryptedBackup {
  return Boolean(value) && typeof value === "object" && (value as Record<string, unknown>).app === "EasyConsole" && (value as Record<string, unknown>).encrypted === true;
}

export async function encryptBackup(backup: LocalDataBackup, password: string): Promise<EncryptedBackup> {
  if (!password) throw new Error("Password is required for encryption");
  if (!rootCrypto) throw new Error("Web Crypto API is not available in this environment");
  const crypto = assertSubtle();
  const encoder = new TextEncoder();
  const salt = rootCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = rootCrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const plaintext = encoder.encode(JSON.stringify(backup));
  const ciphertext = await crypto.encrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, asBufferSource(plaintext));
  return {
    app: "EasyConsole",
    encrypted: true,
    version: 1,
    exportedAt: backup.exportedAt,
    kdf: {
      algorithm: "PBKDF2",
      hash: PBKDF2_HASH,
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: {
      algorithm: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
}

export async function decryptBackup(encrypted: EncryptedBackup, password: string): Promise<LocalDataBackup> {
  if (!password) throw new Error("Password is required for decryption");
  const crypto = assertSubtle();
  const decoder = new TextDecoder();
  const salt = base64ToBytes(encrypted.kdf.salt);
  const iv = base64ToBytes(encrypted.cipher.iv);
  const ciphertext = base64ToBytes(encrypted.cipher.ciphertext);
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.decrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, asBufferSource(ciphertext));
  } catch {
    throw new Error("Decryption failed. Incorrect password or corrupted file.");
  }
  const json = decoder.decode(plaintext);
  return JSON.parse(json) as LocalDataBackup;
}
