import { createContext } from "react";

import type { SavedLoginAccount } from "./saved-accounts";
import type { UserInfo } from "./types";

export type AuthState = {
  token: string | null;
  user: UserInfo | null;
  ready: boolean;
  savedAccounts: SavedLoginAccount[];
  login(username: string, password: string): Promise<void>;
  loginSaved(accountId: string): Promise<void>;
  forgetSavedAccount(accountId: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);
