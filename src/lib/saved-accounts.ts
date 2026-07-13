import type { UserInfo } from "./types";
import type { RuntimeStorage } from "./types";

export const SAVED_ACCOUNTS_STORAGE_KEY = "easy-console.saved-accounts";
const MAX_SAVED_ACCOUNTS = 5;

export type SavedLoginAccount = {
  id: string;
  username: string;
  displayName: string;
  token: string;
  lastLoginAt: string;
  user?: UserInfo;
  /**
   * Optional AES-GCM ciphertext of the user's password (see password-crypto.ts).
   * When present, loginSaved can silently re-login with the password when the
   * stored token has expired. Empty string is treated as "not stored".
   */
  encryptedPassword?: string;
};

export type SavedLoginAccountInput = {
  username: string;
  token: string;
  user?: UserInfo | null;
  now?: Date;
  encryptedPassword?: string;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value: string) {
  return value.trim().toLowerCase();
}

export function getSavedAccountLabel(account: SavedLoginAccount) {
  return account.displayName || account.username || account.id;
}

export function hasStoredPassword(account: Pick<SavedLoginAccount, "encryptedPassword">): boolean {
  return Boolean(account.encryptedPassword);
}

export function createSavedLoginAccount({
  username,
  token,
  user,
  now = new Date(),
  encryptedPassword,
}: SavedLoginAccountInput): SavedLoginAccount {
  const trimmedUsername = username.trim();
  const userId = user?.id === undefined || user.id === null ? "" : String(user.id);
  const displayName = asString(user?.username) || asString(user?.name) || trimmedUsername;
  const id = normalizeId(userId || trimmedUsername || displayName);
  const trimmedEncryptedPassword = typeof encryptedPassword === "string" ? encryptedPassword.trim() : "";

  return {
    id,
    username: trimmedUsername || displayName,
    displayName,
    token,
    lastLoginAt: now.toISOString(),
    user: user ?? undefined,
    ...(trimmedEncryptedPassword ? { encryptedPassword: trimmedEncryptedPassword } : {}),
  };
}

export function parseSavedAccounts(raw: string | null): SavedLoginAccount[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item): SavedLoginAccount | null => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const id = asString(record.id);
        const username = asString(record.username);
        const displayName = asString(record.displayName) || username;
        const token = asString(record.token);
        const lastLoginAt = asString(record.lastLoginAt);
        const encryptedPassword = asString(record.encryptedPassword);
        if (!id || !username || !token) return null;

        return {
          id,
          username,
          displayName,
          token,
          lastLoginAt: lastLoginAt || new Date(0).toISOString(),
          user: record.user && typeof record.user === "object" ? (record.user as UserInfo) : undefined,
          ...(encryptedPassword ? { encryptedPassword } : {}),
        };
      })
      .filter((item): item is SavedLoginAccount => Boolean(item))
      .sort((left, right) => Date.parse(right.lastLoginAt) - Date.parse(left.lastLoginAt))
      .slice(0, MAX_SAVED_ACCOUNTS);
  } catch {
    return [];
  }
}

export function stringifySavedAccounts(accounts: SavedLoginAccount[]) {
  return JSON.stringify(accounts.slice(0, MAX_SAVED_ACCOUNTS));
}

export function upsertSavedAccount(accounts: SavedLoginAccount[], account: SavedLoginAccount) {
  return [account, ...accounts.filter((item) => item.id !== account.id)].slice(0, MAX_SAVED_ACCOUNTS);
}

export function removeSavedAccount(accounts: SavedLoginAccount[], accountId: string) {
  return accounts.filter((item) => item.id !== accountId);
}

/**
 * Migrate saved accounts from plaintext storage to secure storage. Idempotent:
 * if the data already exists in secure storage or the plaintext source is
 * empty, it is a no-op. On success the plaintext copy is removed.
 */
export async function migrateSavedAccountsToSecureStorage(
  plaintext: RuntimeStorage,
  secure: RuntimeStorage,
): Promise<void> {
  const existing = await secure.get(SAVED_ACCOUNTS_STORAGE_KEY);
  if (existing) return;

  const raw = await plaintext.get(SAVED_ACCOUNTS_STORAGE_KEY);
  if (!raw) return;

  await secure.set(SAVED_ACCOUNTS_STORAGE_KEY, raw);
  await plaintext.remove(SAVED_ACCOUNTS_STORAGE_KEY);
}
