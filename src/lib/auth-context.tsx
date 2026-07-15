import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { apiClient, authApi } from "./api";
import { APP_SETTINGS_STORAGE_KEY, parseAppSettings, setRuntimeSettings } from "./app-settings";
import { AuthContext, type LoginOptions } from "./auth-state";
import { TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT } from "./api-client";
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
import type { UserInfo } from "./types";

function writeAuthLog(input: Omit<RunLogInput, "channel" | "source">) {
  void appendRunLog(browserRuntime.storage, {
    ...input,
    channel: browserRuntime.runLogChannel,
    source: "auth",
  }).catch((error) => console.warn("Failed to write auth run log.", error));
}

/**
 * Migrate a single key from plaintext storage to secure storage. Idempotent.
 */
async function migrateKeyToSecureStorage(key: string) {
  const existing = await browserRuntime.secureStorage.get(key);
  if (existing) return;
  const raw = await browserRuntime.storage.get(key);
  if (!raw) return;
  await browserRuntime.secureStorage.set(key, raw);
  await browserRuntime.storage.remove(key);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedLoginAccount[]>([]);
  const savedAccountsRef = useRef<SavedLoginAccount[]>([]);
  const refreshAttemptedRef = useRef(false);
  const loginSavedRef = useRef<((accountId: string) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Migrate any plaintext token/savedAccounts from older versions into secure storage.
    Promise.all([
      migrateKeyToSecureStorage(TOKEN_STORAGE_KEY),
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
          const settings = parseAppSettings(settingsData);
          setRuntimeSettings(settings);
          apiClient.setBaseUrl(settings.apiBaseUrl);
          const parsedAccounts = parseSavedAccounts(savedAccountData);
          savedAccountsRef.current = parsedAccounts;
          setSavedAccounts(parsedAccounts);
          setToken(savedToken);
          apiClient.setToken(savedToken);
          setReady(true);
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
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !token || user) return;
    let cancelled = false;
    authApi
      .userInfo()
      .then((next) => {
        if (cancelled) return;
        setUser(next);
      })
      .catch(async () => {
        if (cancelled) return;
        // Token expired or rejected. Try to silently re-login with the most
        // recent saved account that has a stored password before kicking the
        // user back to the login page.
        const account = savedAccountsRef.current[0];
        if (account?.encryptedPassword && loginSavedRef.current) {
          try {
            await loginSavedRef.current(account.id);
            return; // loginSaved sets token and user on success
          } catch {
            if (cancelled) return;
            // Fall through to clear token
          }
        }
        void browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
        apiClient.setToken(null);
        setToken(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, token, user]);

  const refreshUser = useCallback(async () => {
    const next = await authApi.userInfo();
    setUser(next);
  }, []);

  const persistSavedAccounts = useCallback(async (nextAccounts: SavedLoginAccount[]) => {
    savedAccountsRef.current = nextAccounts;
    setSavedAccounts(nextAccounts);
    await browserRuntime.secureStorage.set(SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts(nextAccounts));
  }, []);

  const login = useCallback(async (username: string, password: string, options?: LoginOptions) => {
    const startedAt = Date.now();
    const rememberPassword = options?.rememberPassword !== false;
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
      setToken(result.token);
      setUser(next);
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
  }, [persistSavedAccounts]);

  const loginSaved = useCallback(async (accountId: string) => {
    const startedAt = Date.now();
    const account = savedAccountsRef.current.find((item) => item.id === accountId);
    if (!account) throw new Error(i18nText("保存的账号不存在", "Saved account does not exist"));

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
            : i18nText("保存的登录已失效，请重新输入密码", "Saved sign-in expired. Enter the password again."),
        );
      }

      try {
        const result = await authApi.login({ username: account.username, password });
        if (!result.token) throw new Error(i18nText("登录响应未包含 token", "Sign-in response did not include a token"));
        activeToken = result.token;
        apiClient.setToken(activeToken);
        await browserRuntime.secureStorage.set(TOKEN_STORAGE_KEY, activeToken);
        next = await authApi.userInfo();
      } catch (reloginError) {
        apiClient.setToken(null);
        await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
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
            : i18nText("保存的登录已失效，请重新输入密码", "Saved sign-in expired. Enter the password again."),
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
    setToken(activeToken);
    setUser(next);
    writeAuthLog({
      level: "info",
      action: "auth.loginSaved",
      result: "success",
      title: i18nText("保存账号登录成功", "Saved account signed in"),
      userName: account.username,
      durationMs: Date.now() - startedAt,
    });
  }, [persistSavedAccounts]);

  // Keep loginSavedRef in sync so the startup auto-relogin effect can call the
  // latest loginSaved without adding it to its dependency array.
  useEffect(() => {
    loginSavedRef.current = loginSaved;
  }, [loginSaved]);

  const forgetSavedAccount = useCallback(async (accountId: string) => {
    await persistSavedAccounts(removeSavedAccount(savedAccountsRef.current, accountId));
  }, [persistSavedAccounts]);

  const logout = useCallback(async () => {
    const userName = user?.username ?? user?.name;
    apiClient.setToken(null);
    await browserRuntime.secureStorage.remove(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
    writeAuthLog({
      level: "info",
      action: "auth.logout",
      result: "success",
      title: i18nText("退出登录", "Signed out"),
      userName,
    });
  }, [user]);

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
          const next = await authApi.userInfo();
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
      // Only trigger logout if refresh was not attempted (refresh handler handles GET retries).
      // Non-GET 401s and refresh failures still reach here.
      void logout();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, [logout]);

  const value = useMemo(
    () => ({ token, user, ready, savedAccounts, login, loginSaved, forgetSavedAccount, logout, refreshUser }),
    [token, user, ready, savedAccounts, login, loginSaved, forgetSavedAccount, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
