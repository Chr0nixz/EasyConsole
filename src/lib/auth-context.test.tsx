import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "./api";
import { TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT, isNetworkError } from "./api-client";
import { getActiveAccountScope, resetAccountScope } from "./account-scope";
import { AuthProvider } from "./auth-context";
import type { AuthState } from "./auth-state";
import { I18nProvider } from "./i18n";
import { decryptPassword, encryptPassword } from "./password-crypto";
import { SAVED_ACCOUNTS_STORAGE_KEY, parseSavedAccounts, stringifySavedAccounts, type SavedLoginAccount } from "./saved-accounts";
import { useAuth } from "./use-auth";

type ResponseLike = {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
};

function envelope(data: unknown, status = 200): ResponseLike {
  return { status, headers: new Headers(), text: async () => JSON.stringify({ code: 0, msg: "ok", data }) };
}

function unauthorized(): ResponseLike {
  return { status: 401, headers: new Headers(), text: async () => JSON.stringify({ code: 10000, msg: "unauthorized" }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeAccount(id: string, username: string, token: string): SavedLoginAccount {
  return {
    id,
    username,
    displayName: username,
    token,
    lastLoginAt: "2026-01-01T00:00:00.000Z",
  };
}

const USERS_BY_TOKEN: Record<string, { username: string; name: string }> = {
  "Bearer old-A": { username: "alice", name: "Alice" },
  "Bearer new-A": { username: "alice", name: "Alice" },
  "Bearer token-B": { username: "bob", name: "Bob" },
};

let handleRequest: ((url: URL, auth: string | undefined) => ResponseLike | Promise<ResponseLike>) | null = null;

/** URL-path router standing in for the console API; keyed on the Authorization header. */
function installFetchStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!handleRequest) throw new Error(`No request handler installed for ${url.pathname}`);
      return (await handleRequest(url, headers.Authorization)) as unknown as Response;
    }),
  );
}

function AuthProbe({ stateRef }: { stateRef: { current: AuthState | null } }) {
  const auth = useAuth();
  useEffect(() => {
    stateRef.current = auth;
  }, [auth, stateRef]);
  return null;
}

describe("AuthProvider token refresh", () => {
  let client: QueryClient;
  let stateRef: { current: AuthState | null };
  let unauthorizedEvents: number;
  const onUnauthorized = () => {
    unauthorizedEvents += 1;
  };

  beforeEach(() => {
    window.localStorage.clear();
    resetAccountScope();
    apiClient.setToken(null);
    apiClient.setRefreshTokenHandler(null);
    installFetchStub();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stateRef = { current: null };
    unauthorizedEvents = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  });

  afterEach(() => {
    window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    apiClient.setToken(null);
    apiClient.setRefreshTokenHandler(null);
    window.localStorage.clear();
    resetAccountScope();
  });

  function renderAuthProvider() {
    render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <AuthProbe stateRef={stateRef} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  function seedSession(token: string, accounts: SavedLoginAccount[]) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    window.localStorage.setItem(SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts(accounts));
  }

  it("applies the refreshed token across state, storage, and the matching saved account", async () => {
    seedSession("Bearer old-A", [makeAccount("alice", "alice", "Bearer old-A")]);
    handleRequest = (url, auth) => {
      if (url.pathname.endsWith("/user/refresh_token")) return envelope("Bearer new-A");
      if (url.pathname.endsWith("/user/userinfo")) return envelope(USERS_BY_TOKEN[auth ?? ""] ?? USERS_BY_TOKEN["Bearer old-A"]);
      if (url.pathname.endsWith("/instance/task")) return auth === "Bearer old-A" ? unauthorized() : envelope({ items: [] });
      return envelope(null);
    };
    renderAuthProvider();
    await waitFor(() => expect(stateRef.current?.ready).toBe(true));

    await act(async () => {
      await expect(apiClient.get("/instance/task")).resolves.toEqual({ items: [] });
    });
    expect(apiClient.getToken()).toBe("Bearer new-A");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("Bearer new-A");
    await waitFor(() => expect(stateRef.current?.token).toBe("Bearer new-A"));
    expect(stateRef.current?.user?.username).toBe("alice");

    const stored = parseSavedAccounts(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0].token).toBe("Bearer new-A");
    // Refreshing must not reorder the saved-accounts list.
    expect(stored[0].lastLoginAt).toBe("2026-01-01T00:00:00.000Z");
    expect(unauthorizedEvents).toBe(0);
  });

  it("drops the refresh result and keeps the new session when the account switches mid-refresh", async () => {
    seedSession("Bearer old-A", [
      makeAccount("alice", "alice", "Bearer old-A"),
      makeAccount("bob", "bob", "Bearer token-B"),
    ]);
    const refreshGate = deferred<"release">();
    let refreshStarted = false;
    handleRequest = async (url, auth) => {
      if (url.pathname.endsWith("/user/refresh_token")) {
        refreshStarted = true;
        await refreshGate.promise;
        return envelope("Bearer new-A");
      }
      if (url.pathname.endsWith("/user/userinfo")) return envelope(USERS_BY_TOKEN[auth ?? ""] ?? USERS_BY_TOKEN["Bearer old-A"]);
      if (url.pathname.endsWith("/instance/task")) return auth === "Bearer old-A" ? unauthorized() : envelope({ items: [] });
      return envelope(null);
    };
    renderAuthProvider();
    await waitFor(() => expect(stateRef.current?.ready).toBe(true));

    const taskPromise = apiClient.get("/instance/task");
    await waitFor(() => expect(refreshStarted).toBe(true));

    // Switch to account B while account A's refresh is still in flight.
    await act(async () => {
      await stateRef.current?.loginSaved("bob");
    });
    expect(apiClient.getToken()).toBe("Bearer token-B");

    // Attach the rejection handler before releasing the gate: the refresh
    // chain rejects the queued request as soon as the gate resolves.
    const rejection = expect(taskPromise).rejects.toThrow(/账号已切换|account changed/i);
    await act(async () => {
      refreshGate.resolve("release");
    });
    await rejection;
    // The previous account's refreshed token must not be written anywhere.
    expect(apiClient.getToken()).toBe("Bearer token-B");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("Bearer token-B");
    await waitFor(() => expect(stateRef.current?.token).toBe("Bearer token-B"));
    expect(stateRef.current?.user?.username).toBe("bob");
    expect(stateRef.current?.sessionExpired).toBe(false);
    expect(unauthorizedEvents).toBe(0);

    const stored = parseSavedAccounts(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY));
    const alice = stored.find((account) => account.id === "alice");
    expect(alice?.token).toBe("Bearer old-A");
  });

  it("repairs the stored token when the account switches after the refresh already applied", async () => {
    seedSession("Bearer old-A", [
      makeAccount("alice", "alice", "Bearer old-A"),
      makeAccount("bob", "bob", "Bearer token-B"),
    ]);
    // The refreshed token applies cleanly, then the userinfo fetch hangs —
    // the switch happens while that request is in flight, so the drop path
    // runs after the new token was already applied and persisted.
    const userinfoGate = deferred<"release">();
    let refreshApplied = false;
    handleRequest = async (url, auth) => {
      if (url.pathname.endsWith("/user/refresh_token")) return envelope("Bearer new-A");
      if (url.pathname.endsWith("/user/userinfo")) {
        if (auth === "Bearer new-A") {
          refreshApplied = true;
          await userinfoGate.promise;
        }
        return envelope(USERS_BY_TOKEN[auth ?? ""] ?? USERS_BY_TOKEN["Bearer old-A"]);
      }
      if (url.pathname.endsWith("/instance/task")) return auth === "Bearer old-A" ? unauthorized() : envelope({ items: [] });
      return envelope(null);
    };
    renderAuthProvider();
    await waitFor(() => expect(stateRef.current?.ready).toBe(true));

    const taskPromise = apiClient.get("/instance/task");
    await waitFor(() => expect(refreshApplied).toBe(true));

    await act(async () => {
      await stateRef.current?.loginSaved("bob");
    });

    const rejection = expect(taskPromise).rejects.toThrow(/账号已切换|account changed/i);
    await act(async () => {
      userinfoGate.resolve("release");
    });
    await rejection;

    // The applied-then-dropped token must not survive anywhere: the active
    // session's token is what storage and state end with.
    expect(apiClient.getToken()).toBe("Bearer token-B");
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("Bearer token-B");
    await waitFor(() => {
      expect(stateRef.current?.token).toBe("Bearer token-B");
      expect(stateRef.current?.user?.username).toBe("bob");
    });
    expect(stateRef.current?.sessionExpired).toBe(false);
    expect(unauthorizedEvents).toBe(0);
  });

  it("keeps the session when the refresh request fails at the network level", async () => {
    seedSession("Bearer old-A", [makeAccount("alice", "alice", "Bearer old-A")]);
    handleRequest = (url, auth) => {
      if (url.pathname.endsWith("/user/refresh_token")) throw new TypeError("fetch failed");
      if (url.pathname.endsWith("/user/userinfo")) return envelope(USERS_BY_TOKEN[auth ?? ""] ?? USERS_BY_TOKEN["Bearer old-A"]);
      if (url.pathname.endsWith("/instance/task")) return unauthorized();
      return envelope(null);
    };
    renderAuthProvider();
    await waitFor(() => expect(stateRef.current?.ready).toBe(true));

    const taskPromise = apiClient.get("/instance/task");
    const error = await taskPromise.catch((caught: unknown) => caught);

    expect(isNetworkError(error)).toBe(true);
    expect(apiClient.getToken()).toBe("Bearer old-A");
    expect(stateRef.current?.sessionExpired).toBe(false);
    expect(unauthorizedEvents).toBe(0);
  });

  it("restores the seeded session on boot and scopes the cache to the account", async () => {
    seedSession("Bearer old-A", [makeAccount("alice", "alice", "Bearer old-A")]);
    handleRequest = (url, auth) => {
      if (url.pathname.endsWith("/user/userinfo")) return envelope(USERS_BY_TOKEN[auth ?? ""] ?? USERS_BY_TOKEN["Bearer old-A"]);
      return envelope(null);
    };
    renderAuthProvider();

    await waitFor(() => expect(stateRef.current?.user?.username).toBe("alice"));
    expect(stateRef.current?.ready).toBe(true);
    expect(stateRef.current?.restoringSession).toBe(false);
    expect(stateRef.current?.token).toBe("Bearer old-A");
    expect(getActiveAccountScope().key).toContain("alice");
  });

  it("silently signs in with a remembered password when the saved token expires", async () => {
    const encryptedPassword = await encryptPassword("local-test-password");
    seedSession("Bearer old-A", [{ ...makeAccount("alice", "alice", "Bearer old-A"), encryptedPassword }]);
    handleRequest = (url, auth) => {
      if (url.pathname.endsWith("/user/userinfo")) return auth === "Bearer new-A" ? envelope(USERS_BY_TOKEN[auth]) : unauthorized();
      if (url.pathname.endsWith("/user/refresh_token")) return unauthorized();
      if (url.pathname.endsWith("/user/token")) return envelope("Bearer new-A");
      return envelope(null);
    };
    renderAuthProvider();

    await waitFor(() => expect(stateRef.current?.user?.username).toBe("alice"));
    expect(stateRef.current?.token).toBe("Bearer new-A");
    expect(stateRef.current?.restoringSession).toBe(false);
    expect(getActiveAccountScope().key).toContain("alice");
    const saved = parseSavedAccounts(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY));
    expect(saved[0].token).toBe("Bearer new-A");
    expect(saved[0].encryptedPassword).not.toBe(encryptedPassword);
    expect(await decryptPassword(saved[0].encryptedPassword!)).toBe("local-test-password");
    expect(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY)).not.toContain("local-test-password");
    const logins = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/user/token"));
    expect(logins).toHaveLength(1);
    expect(JSON.parse(String(logins[0][1]?.body))).toMatchObject({ username: "alice", password: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it.each([undefined, "malformed-encrypted-password"])("returns to password sign-in when the token expires without a usable remembered password (%s)", async (encryptedPassword) => {
    seedSession("Bearer old-A", [{ ...makeAccount("alice", "alice", "Bearer old-A"), encryptedPassword }]);
    handleRequest = () => unauthorized();
    renderAuthProvider();

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/user/userinfo"))).toBe(true);
      expect(stateRef.current?.ready).toBe(true);
      expect(stateRef.current?.restoringSession).toBe(false);
      expect(stateRef.current?.token).toBeNull();
      expect(apiClient.getToken()).toBeNull();
    });
    expect(stateRef.current?.user).toBeNull();
    expect(apiClient.getToken()).toBeNull();
    expect(getActiveAccountScope().key).toBe("anonymous");
    expect(parseSavedAccounts(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY))).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/user/token"))).toBe(false);
  });

  it("retains the saved account for correction when remembered-password sign-in is rejected", async () => {
    const encryptedPassword = await encryptPassword("local-test-password");
    seedSession("Bearer old-A", [{ ...makeAccount("alice", "alice", "Bearer old-A"), encryptedPassword }]);
    handleRequest = () => unauthorized();
    renderAuthProvider();

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/user/token"))).toHaveLength(1);
      expect(stateRef.current?.ready).toBe(true);
      expect(stateRef.current?.restoringSession).toBe(false);
      expect(stateRef.current?.token).toBeNull();
      expect(apiClient.getToken()).toBeNull();
    });
    expect(stateRef.current?.user).toBeNull();
    expect(apiClient.getToken()).toBeNull();
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(parseSavedAccounts(window.localStorage.getItem(SAVED_ACCOUNTS_STORAGE_KEY))[0]).toMatchObject({ username: "alice", encryptedPassword });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/user/token"))).toHaveLength(1);
  });
});
