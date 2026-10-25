import type { QueryClient } from "@tanstack/react-query";

/**
 * Account identity used to scope caches and local automation records.
 * Derived from the normalized username plus the API base URL realm, so the
 * same username on two different consoles gets two different scopes. Never
 * contains tokens, passwords, or any other secret.
 */
export type AccountScope = {
  key: string;
  displayName: string;
};

export const ANONYMOUS_ACCOUNT_SCOPE_KEY = "anonymous";

export const ANONYMOUS_ACCOUNT_SCOPE: AccountScope = { key: ANONYMOUS_ACCOUNT_SCOPE_KEY, displayName: "" };

const ANONYMOUS_SCOPE: AccountScope = ANONYMOUS_ACCOUNT_SCOPE;

/** Collapse an API base URL to a stable realm string (scheme-less, lowercase). */
export function normalizeApiRealm(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().toLowerCase();
  if (!trimmed) return "default";
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path}`;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/** Stable, secret-free account identifier: `normalized-username@api-realm`. */
export function accountScopeKey(username: string, apiBaseUrl: string): string {
  const normalizedUsername = username.trim().toLowerCase();
  return `${normalizedUsername || "user"}@${normalizeApiRealm(apiBaseUrl)}`;
}

export function makeAccountScope(username: string, displayName: string, apiBaseUrl: string): AccountScope {
  const trimmedUsername = username.trim();
  return {
    key: accountScopeKey(trimmedUsername, apiBaseUrl),
    displayName: displayName.trim() || trimmedUsername,
  };
}

let activeScope: AccountScope = ANONYMOUS_SCOPE;

export function getActiveAccountScope(): AccountScope {
  return activeScope;
}

export function setActiveAccountScope(scope: AccountScope) {
  activeScope = scope && scope.key ? scope : ANONYMOUS_SCOPE;
}

export function resetAccountScope() {
  activeScope = ANONYMOUS_SCOPE;
}

/**
 * Switch the active account scope and drop everything the previous account
 * cached. In-flight queries are cancelled first so a late response can never
 * repopulate the cache for the next account. Re-applying the same account
 * (silent re-login) keeps the cache.
 */
export async function applyAccountQueryScope(queryClient: QueryClient, nextScope: AccountScope) {
  const previous = getActiveAccountScope();
  const normalized = nextScope && nextScope.key ? nextScope : ANONYMOUS_SCOPE;
  setActiveAccountScope(normalized);
  if (previous.key === normalized.key) return;
  await queryClient.cancelQueries();
  queryClient.removeQueries();
}
