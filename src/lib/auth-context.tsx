import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { apiClient, authApi, setApiBaseUrl } from "./api";
import {
  ANONYMOUS_ACCOUNT_SCOPE,
  applyAccountQueryScope,
  makeAccountScope,
  type AccountScope,
} from "./account-scope";
import {
  APP_SETTINGS_STORAGE_KEY,
  GLOBAL_SETTINGS_ACCOUNT_ID,
  deleteAccountSettings,
  deleteAccountSshPassword,
  getAccountAppSettings,
  hydrateAccountSshPassword,
  loadAccountSettings,
  parseAccountSettingsStore,
  readAccountSettingsStore,
  removeAccountAppSettings,
  setRuntimeSettings,
  upsertAccountAppSettings,
  writeAccountSettingsStore,
} from "./app-settings";
import { AuthContext, type LoginOptions } from "./auth-state";
import { TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT, isNetworkError } from "./api-client";
import { i18nText } from "./i18n-text";
import { encryptPassword, decryptPassword } from "./password-crypto";
import { browserRuntime } from "./runtime";
import { appendRunLog, type RunLogInput } from "./run-logs";
import {
  createSavedLoginAccount,
  migrateSavedAccountsToSecureStorage,
  parseSavedAccounts,
  removeSavedAccount,
  SAVED_ACCOUNTS_STORAGE_KEY,
  stringifySavedAccounts,
  type SavedLoginAccount,
  upsertSavedAccount,
} from "./saved-accounts";
import { migrateKeyToSecureStorage } from "./secure-storage";
import type { UserInfo } from "./types";

function writeAuthLog(input: Omit<RunLogInput, "channel" | "source">) {
  void appendRunLog(browserRuntime.storage, {
    ...input,
    channel: browserRuntime.runLogChannel,
    source: "auth",
  }).catch((error) => console.warn("Failed to write auth run log.", error));
}

async function applyAccountRuntimeSettings(accountId: string) {
  const settings = await loadAccountSettings(browserRuntime.storage, accountId);
  setRuntimeSettings(settings);
  // The SSH default password is kept in secureStorage; load it into the
  // runtime settings before any task list can consume it. The web runtime
  // never persists it — its secureStorage is plain localStorage — so the
  // value only lives in memory there.
  await hydrateAccountSshPassword(browserRuntime.storage, browserRuntime.secureStorage, accountId, {
    persist: browserRuntime.runtimeKind !== "web",
  }).catch((error) => console.warn("Failed to hydrate the SSH default password.", error));
  setApiBaseUrl(settings.apiBaseUrl);
  void browserRuntime.setDesktopCloseToTray(settings.desktopCloseToTray);
  void browserRuntime.setDesktopClosePrompt(settings.desktopClosePrompt);
  return settings;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  // Set when the session ended because the server rejected the token, so the login page can
  // say why the user is there; any successful sign-in clears it.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedLoginAccount[]>([]);
  const savedAccountsRef = useRef<SavedLoginAccount[]>([]);
  const refreshAttemptedRef = useRef(false);
  const loginSavedRef = useRef<((accountId: string) => Promise<void>) | null>(null);
  const reloginInProgressRef = useRef(false);
  const sessionRestoreStartedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Migrate any plaintext token/savedAccounts from older versions into secure storage.
    Promise.all([
      migrateKeyToSecureStorage(browserRuntime.storage, browserRuntime.secureStorage, TOKEN_STORAGE_KEY),
      migrateSavedAccountsToSecureStorage(browserRuntime.storage, browserRuntime.secureStorage),
    ])
      .then(() =>
        Promise.all([
          browserRuntime.storage.get(APP_SETTINGS_STORAGE_KEY),
          browserRuntime.secureStorage.get(TOKEN_STORAGE_KEY),
          browserRuntime.secureStorage.get(SAVED_ACCOUNTS_STORAGE_KEY),
        ]),
      )
      .then(
        ([settingsData, savedToken, savedAccountData]) => {
          if (cancelled) return;
          const store = parseAccountSettingsStore(settingsData);
          const parsedAccounts = parseSavedAccounts(savedAccountData);
          const bootAccountId = parsedAccounts[0]?.id ?? GLOBAL_SETTINGS_ACCOUNT_ID;
          const settings = getAccountAppSettings(store, bootAccountId);
          setRuntimeSettings(settings);
          setApiBaseUrl(settings.apiBaseUrl);
          void browserRuntime.setDesktopCloseToTray(settings.desktopCloseToTray);
          void browserRuntime.setDesktopClosePrompt(settings.desktopClosePrompt);
          savedAccountsRef.current = parsedAccounts;
          setSavedAccounts(parsedAccounts);
          setToken(savedToken);
          apiClient.setToken(savedToken);
          setReady(true);
          // If there is nothing to restore, stop showing the restore spinner.
          if (!savedToken && !parsedAccounts.some((account) => account.encryptedPassword)) {
            setRestoringSession(false);
          }
          // The SSH default password lives in secureStorage, not the store
          // JSON; hydrate it (and migrate any legacy plaintext copy) once
          // the rest of the boot is complete. The web runtime only holds it
          // in memory.
          void hydrateAccountSshPassword(
            browserRuntime.storage,
            browserRuntime.secureStorage,
            bootAccountId,
            { persist: browserRuntime.runtimeKind !== "web" },
          ).catch((error) => console.warn("Failed to hydrate the SSH default password.", error));
        },
        (error) => {
          if (cancelled) return;
          console.error("Auth initialization failed.", error);
          writeAuthLog({
            level: "error",
            action: "auth.init",
            result: "failure",
            title: i18nText("初始化失败", "Initialization failed"),
            error: error instanceof Error ? error.message : String(error),
          });
          setReady(true);
          setRestoringSession(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshUser = useCallback(async () => {
    const next = await authApi.userInfo();
    setUser(next);
  }, []);

  const persistSavedAccounts = useCallback(async (nextAccounts: SavedLoginAccount[]) => {
    savedAccountsRef.current = nextAccounts;
    setSavedAccounts(nextAccounts);
    await browserRuntime.secureStorage.set(SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts(nextAccounts));
  }, []);

  /**
   * Bind the query-cache account scope to the session before the new user
   * state renders. Switching accounts cancels in-flight queries and drops the
   * previous account's cache so its data can neither flash nor be refilled by
   * a late response.
   */
  const commitAccountScope = useCallback(
    async (scope: AccountScope) => {
      await applyAccountQueryScope(queryClient, scope);
    },
    [queryClient],
  );

  const makeScopeFor = useCallback((username: string, displayName: string | undefined) => {
    return makeAccountScope(username, displayName || username, apiClient.getBaseUrl());
  }, []);

  const login = useCallback(async (username: string, password: string, options?: LoginOptions) => {
    const startedAt = Date.now();
    const rememberPassword = options?.rememberPassword === true;
    const result = await authApi.login({ username, password });
    if (!result.token) throw new Error(i18nText("登录响应未包含 token", "Sign-in response did not include a token"));
    apiClient.setToken(result.token);
    await browserRuntime.secureStorage.set(TOKEN_STORAGE_KEY, result.token);
    try {
      const next = await authApi.userInfo();
      const encryptedPassword = rememberPassword ? await encryptPassword(password).catch(() => "") : "";
      const nextAccount = createSavedLoginAccount({
        username,
        token: result.token,
        user: next,
        encryptedPassword: encryptedPassword || undefined,
      });
      await persistSavedAccounts(upsertSavedAccount(savedAccountsRef.current, nextAccount));
      await applyAccountRuntimeSettings(nextAccount.id);
      await commitAccountScope(makeScopeFor(username, next.username || next.name));
      setToken(result.token);
      setUser(next);
      setRestoringSession(false);
      setSessionExpired(false);
      writeAuthLog({
        level: "info",
        action: "auth.login",
        result: "success",
        title: i18nText("登录成功", "Signed in"),
        userName: username,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      apiClient.setToken(null);
      await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
      writeAuthLog({
        level: "error",
        action: "auth.login",
        result: "failure",
        title: i18nText("登录失败", "Sign-in failed"),
        userName: username,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : i18nText("登录失败", "Sign-in failed"),
      });
      throw error;
    }
  }, [commitAccountScope, makeScopeFor, persistSavedAccounts]);

  const loginSaved = useCallback(async (accountId: string) => {
    reloginInProgressRef.current = true;
    try {
      const startedAt = Date.now();
      const account = savedAccountsRef.current.find((item) => item.id === accountId);
      if (!account) throw new Error(i18nText("保存的账号不存在", "Saved account does not exist"));

      // Apply this account's settings (including API base URL) before auth calls.
      await applyAccountRuntimeSettings(accountId);

      apiClient.setToken(account.token);
      await browserRuntime.secureStorage.set(TOKEN_STORAGE_KEY, account.token);

      let next: UserInfo;
      let activeToken: string = account.token;
      try {
        // Fast path: the saved token is still valid.
        next = await authApi.userInfo();
      } catch (tokenError) {
        // Token expired or rejected. Try to silently re-login with the stored
        // password, if we have one. Otherwise surface the original failure.
        const password = account.encryptedPassword
          ? await decryptPassword(account.encryptedPassword).catch(() => "")
          : "";
        if (!password) {
          apiClient.setToken(null);
          await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
          await commitAccountScope(ANONYMOUS_ACCOUNT_SCOPE);
          setToken(null);
          setUser(null);
          writeAuthLog({
            level: "error",
            action: "auth.loginSaved",
            result: "failure",
            title: i18nText("保存账号登录失败", "Saved account sign-in failed"),
            userName: account.username,
            durationMs: Date.now() - startedAt,
            error: tokenError instanceof Error ? tokenError.message : i18nText("保存账号登录失败", "Saved account sign-in failed"),
          });
          throw new Error(
            tokenError instanceof Error
              ? i18nText(`保存的登录已失效：${tokenError.message}`, `Saved sign-in expired: ${tokenError.message}`)
              : i18nText("保存的登录凭据已失效，请重新输入密码", "Saved sign-in expired. Please re-enter your password."),
            { cause: tokenError },
          );
        }

        try {
          const result = await authApi.login({ username: account.username, password });
          if (!result.token) {
            throw new Error(i18nText("登录响应未包含 token", "Sign-in response did not include a token"), { cause: tokenError });
          }
          activeToken = result.token;
          apiClient.setToken(activeToken);
          await browserRuntime.secureStorage.set(TOKEN_STORAGE_KEY, activeToken);
          next = await authApi.userInfo();
        } catch (reloginError) {
          apiClient.setToken(null);
          await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
          await commitAccountScope(ANONYMOUS_ACCOUNT_SCOPE);
          setToken(null);
          setUser(null);
          writeAuthLog({
            level: "error",
            action: "auth.loginSaved",
            result: "failure",
            title: i18nText("保存账号登录失败", "Saved account sign-in failed"),
            userName: account.username,
            durationMs: Date.now() - startedAt,
            error: reloginError instanceof Error ? reloginError.message : i18nText("保存账号登录失败", "Saved account sign-in failed"),
          });
          throw new Error(
            reloginError instanceof Error
              ? i18nText(`保存的登录已失效：${reloginError.message}`, `Saved sign-in expired: ${reloginError.message}`)
              : i18nText("保存的登录凭据已失效，请重新输入密码", "Saved sign-in expired. Please re-enter your password."),
            { cause: reloginError },
          );
        }
      }

      // Re-encrypt the password with a fresh salt/IV so the same ciphertext is
      // not reused indefinitely. We re-derive from the decrypted plaintext.
      let nextEncryptedPassword = account.encryptedPassword;
      if (account.encryptedPassword) {
        const plaintext = await decryptPassword(account.encryptedPassword).catch(() => "");
        if (plaintext) {
          nextEncryptedPassword = await encryptPassword(plaintext).catch(() => account.encryptedPassword);
        }
      }

      const nextAccount = createSavedLoginAccount({
        username: account.username,
        token: activeToken,
        user: next,
        encryptedPassword: nextEncryptedPassword,
      });
      await persistSavedAccounts(upsertSavedAccount(savedAccountsRef.current, nextAccount));
      // Account id can change when userinfo returns a backend id for the first time.
      if (nextAccount.id !== accountId) {
        const store = await readAccountSettingsStore(browserRuntime.storage);
        const previous = store.byAccount[accountId];
        let nextStore = store;
        if (previous && !store.byAccount[nextAccount.id]) {
          nextStore = upsertAccountAppSettings(nextStore, nextAccount.id, previous);
        }
        nextStore = removeAccountAppSettings(nextStore, accountId);
        await writeAccountSettingsStore(browserRuntime.storage, nextStore);
        await applyAccountRuntimeSettings(nextAccount.id);
      }
      await commitAccountScope(makeScopeFor(account.username, next.username || next.name));
      setToken(activeToken);
      setUser(next);
      setRestoringSession(false);
      setSessionExpired(false);
      writeAuthLog({
        level: "info",
        action: "auth.loginSaved",
        result: "success",
        title: i18nText("保存账号登录成功", "Saved account signed in"),
        userName: account.username,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      reloginInProgressRef.current = false;
    }
  }, [commitAccountScope, makeScopeFor, persistSavedAccounts]);

  // Keep loginSavedRef in sync so the startup auto-relogin effect can call the
  // latest loginSaved without adding it to its dependency array.
  useEffect(() => {
    loginSavedRef.current = loginSaved;
  }, [loginSaved]);

  useEffect(() => {
    if (!ready || user || sessionRestoreStartedRef.current) return;
    const hasRememberedPassword = savedAccountsRef.current.some((account) => account.encryptedPassword);
    if (!token && !hasRememberedPassword) {
      setRestoringSession(false);
      return;
    }
    // Wait until loginSaved is wired; otherwise the first ready tick can miss silent restore.
    if (!loginSavedRef.current) return;

    sessionRestoreStartedRef.current = true;
    let cancelled = false;

    async function restoreSession() {
      setRestoringSession(true);
      try {
        if (token) {
          try {
            const next = await authApi.userInfo();
            if (cancelled) return;
            // Scope the cache to the restored account before protected pages
            // render their first queries. Prefer the saved account that owns
            // this token; userinfo may lack a username on some backends.
            const accountByToken = savedAccountsRef.current.find((item) => item.token === token);
            const restoredName = String(next.username ?? next.name ?? accountByToken?.username ?? "");
            await commitAccountScope(makeScopeFor(restoredName, restoredName));
            setUser(next);
            return;
          } catch {
            if (cancelled) return;
            // Token expired or rejected. Try silent re-login with a stored password.
            const account =
              savedAccountsRef.current.find((item) => item.encryptedPassword) ?? savedAccountsRef.current[0];
            if (account?.encryptedPassword && loginSavedRef.current) {
              try {
                await loginSavedRef.current(account.id);
                return;
              } catch {
                if (cancelled) return;
              }
            }
            void browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
            apiClient.setToken(null);
            setToken(null);
            return;
          }
        }

        // No persisted token, but a remembered password is available.
        const account = savedAccountsRef.current.find((item) => item.encryptedPassword);
        if (account && loginSavedRef.current) {
          try {
            await loginSavedRef.current(account.id);
          } catch {
            // Stay on the login page; saved accounts remain available for one-click retry.
          }
        }
      } finally {
        if (!cancelled) setRestoringSession(false);
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [ready, token, user, loginSaved, commitAccountScope, makeScopeFor]);

  const forgetSavedAccount = useCallback(async (accountId: string) => {
    await persistSavedAccounts(removeSavedAccount(savedAccountsRef.current, accountId));
    await deleteAccountSettings(browserRuntime.storage, accountId).catch((error) => {
      console.warn("Failed to remove per-account settings.", error);
    });
    await deleteAccountSshPassword(browserRuntime.secureStorage, accountId).catch((error) => {
      console.warn("Failed to remove the stored SSH default password.", error);
    });
  }, [persistSavedAccounts]);

  const clearSavedPassword = useCallback(async (accountId: string) => {
    const account = savedAccountsRef.current.find((item) => item.id === accountId);
    if (!account?.encryptedPassword) return;
    const { encryptedPassword: _removed, ...rest } = account;
    void _removed;
    await persistSavedAccounts(upsertSavedAccount(savedAccountsRef.current, rest));
  }, [persistSavedAccounts]);

  const logout = useCallback(async (options?: { expired?: boolean }) => {
    const userName = user?.username ?? user?.name;
    apiClient.setToken(null);
    await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
    // Cancel in-flight queries and drop the account-scoped cache so the next
    // account (or the login page) never sees or receives this account's data.
    await applyAccountQueryScope(queryClient, ANONYMOUS_ACCOUNT_SCOPE);
    setToken(null);
    setUser(null);
    setRestoringSession(false);
    setSessionExpired(Boolean(options?.expired));
    await applyAccountRuntimeSettings(GLOBAL_SETTINGS_ACCOUNT_ID).catch((error) => {
      console.warn("Failed to restore global settings after logout.", error);
    });
    writeAuthLog({
      level: "info",
      action: "auth.logout",
      result: "success",
      title: i18nText("退出登录", "Signed out"),
      userName,
    });
  }, [queryClient, user]);

  // Inject the token refresh handler into the API client.
  // On 401 for GET requests, the client will call this handler to attempt a token refresh
  // before rejecting the request. If refresh fails, it emits UNAUTHORIZED_EVENT to trigger logout.
  useEffect(() => {
    apiClient.setRefreshTokenHandler(async (currentToken: string) => {
      if (refreshAttemptedRef.current) return null;
      refreshAttemptedRef.current = true;
      try {
        const newToken = await authApi.refreshToken(currentToken);
        if (!newToken) return null;
        await browserRuntime.secureStorage.set(TOKEN_STORAGE_KEY, newToken);
        apiClient.setToken(newToken);
        setToken(newToken);
        try {
          // Bypass the automatic refresh queue: a 401 here would otherwise wait
          // on the refresh cycle this handler is part of and deadlock it.
          const next = await apiClient.get<UserInfo>("/user/userinfo", { _skipRefresh: true });
          setUser(next);
        } catch {
          // User info refresh is best-effort; the token itself was refreshed successfully.
        }
        writeAuthLog({
          level: "info",
          action: "auth.tokenRefresh",
          result: "success",
          title: i18nText("登录令牌已自动刷新", "Sign-in token refreshed automatically"),
        });
        return newToken;
      } catch (error) {
        if (isNetworkError(error)) {
          // Transient connectivity failure: let the client release the waiting
          // queue with the original error without emitting unauthorized, so a
          // network blip does not log the session out.
          writeAuthLog({
            level: "warning",
            action: "auth.tokenRefresh",
            result: "failure",
            title: i18nText("刷新登录令牌时网络中断", "Network interrupted while refreshing the sign-in token"),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        writeAuthLog({
          level: "error",
          action: "auth.tokenRefresh",
          result: "failure",
          title: i18nText("登录令牌刷新失败", "Failed to refresh sign-in token"),
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        refreshAttemptedRef.current = false;
      }
    });
    return () => {
      apiClient.setRefreshTokenHandler(null);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      // Suppress logout during loginSaved auto-relogin. The loginSaved flow
      // handles token-expired internally (decrypts password and re-logs in).
      // Without this guard, the UNAUTHORIZED_EVENT emitted by api-client's
      // failed token-refresh races with loginSaved and clears the freshly
      // restored session.
      if (reloginInProgressRef.current) return;
      void logout({ expired: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, [logout]);

  const value = useMemo(
    () => ({ token, user, ready, restoringSession, sessionExpired, savedAccounts, login, loginSaved, forgetSavedAccount, clearSavedPassword, logout, refreshUser }),
    [token, user, ready, restoringSession, sessionExpired, savedAccounts, login, loginSaved, forgetSavedAccount, clearSavedPassword, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
