import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { apiClient, authApi } from "./api";
import { AuthContext } from "./auth-state";
import { TOKEN_STORAGE_KEY, UNAUTHORIZED_EVENT } from "./api-client";
import { browserRuntime } from "./runtime";
import type { UserInfo } from "./types";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    browserRuntime.storage.get(TOKEN_STORAGE_KEY).then((saved) => {
      setToken(saved);
      apiClient.setToken(saved);
      setReady(true);
    });
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

  const login = useCallback(async (username: string, password: string) => {
    const result = await authApi.login({ username, password });
    if (!result.token) throw new Error("登录响应未包含 token");
    apiClient.setToken(result.token);
    await browserRuntime.storage.set(TOKEN_STORAGE_KEY, result.token);
    try {
      const next = await authApi.userInfo();
      setToken(result.token);
      setUser(next);
    } catch (error) {
      apiClient.setToken(null);
      await browserRuntime.storage.remove(TOKEN_STORAGE_KEY);
      throw error;
    }
  }, []);

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

  const value = useMemo(() => ({ token, user, ready, login, logout, refreshUser }), [token, user, ready, login, logout, refreshUser]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
