import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { apiClient, authApi } from "./api";
import { AuthContext } from "./auth-state";
import { TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT } from "./api-client";
import { browserRuntime } from "./runtime";
import {
  createSavedLoginAccount,
  parseSavedAccounts,
  removeSavedAccount,
  SAVED_ACCOUNTS_STORAGE_KEY,
  stringifySavedAccounts,
  type SavedLoginAccount,
  upsertSavedAccount,
} from "./saved-accounts";
import type { UserInfo } from "./types";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedLoginAccount[]>([]);
  const savedAccountsRef = useRef<SavedLoginAccount[]>([]);

  useEffect(() => {
    Promise.all([browserRuntime.storage.get(TOKEN_STORAGE_KEY), browserRuntime.storage.get(SAVED_ACCOUNTS_STORAGE_KEY)]).then(
      ([savedToken, savedAccountData]) => {
        const parsedAccounts = parseSavedAccounts(savedAccountData);
        savedAccountsRef.current = parsedAccounts;
        setSavedAccounts(parsedAccounts);
        setToken(savedToken);
        apiClient.setToken(savedToken);
        setReady(true);
      },
    );
  }, []);

  useEffect(() => {
    if (!ready || !token || user) return;
    authApi
      .userInfo()
      .then(setUser)
      .catch(() => {
        void browserRuntime.storage.remove(TOKEN_STORAGE_KEY);
        apiClient.setToken(null);
        setToken(null);
      });
  }, [ready, token, user]);

  const refreshUser = useCallback(async () => {
    const next = await authApi.userInfo();
    setUser(next);
  }, []);

  const persistSavedAccounts = useCallback(async (nextAccounts: SavedLoginAccount[]) => {
    savedAccountsRef.current = nextAccounts;
    setSavedAccounts(nextAccounts);
    await browserRuntime.storage.set(SAVED_ACCOUNTS_STORAGE_KEY, stringifySavedAccounts(nextAccounts));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await authApi.login({ username, password });
    if (!result.token) throw new Error("登录响应未包含 token");
    apiClient.setToken(result.token);
    await browserRuntime.storage.set(TOKEN_STORAGE_KEY, result.token);
    try {
      const next = await authApi.userInfo();
      const nextAccount = createSavedLoginAccount({ username, token: result.token, user: next });
      await persistSavedAccounts(upsertSavedAccount(savedAccountsRef.current, nextAccount));
      setToken(result.token);
      setUser(next);
    } catch (error) {
      apiClient.setToken(null);
      await browserRuntime.storage.remove(TOKEN_STORAGE_KEY);
      throw error;
    }
  }, [persistSavedAccounts]);

  const loginSaved = useCallback(async (accountId: string) => {
    const account = savedAccountsRef.current.find((item) => item.id === accountId);
    if (!account) throw new Error("保存的账号不存在");

    apiClient.setToken(account.token);
    await browserRuntime.storage.set(TOKEN_STORAGE_KEY, account.token);
    try {
      const next = await authApi.userInfo();
      const nextAccount = createSavedLoginAccount({ username: account.username, token: account.token, user: next });
      await persistSavedAccounts(upsertSavedAccount(savedAccountsRef.current, nextAccount));
      setToken(account.token);
      setUser(next);
    } catch (error) {
      apiClient.setToken(null);
      await browserRuntime.storage.remove(TOKEN_STORAGE_KEY);
      setToken(null);
      setUser(null);
      throw new Error(error instanceof Error ? `保存的登录已失效：${error.message}` : "保存的登录已失效，请重新输入密码");
    }
  }, [persistSavedAccounts]);

  const forgetSavedAccount = useCallback(async (accountId: string) => {
    await persistSavedAccounts(removeSavedAccount(savedAccountsRef.current, accountId));
  }, [persistSavedAccounts]);

  const logout = useCallback(async () => {
    apiClient.setToken(null);
    await browserRuntime.storage.remove(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const handler = () => {
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
