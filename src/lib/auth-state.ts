import { createContext } from "react";

import type { UserInfo } from "./types";

export type AuthState = {
  token: string | null;
  user: UserInfo | null;
  ready: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);
