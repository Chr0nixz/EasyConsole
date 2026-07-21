import { createContext } from "react";

import type { SavedLoginAccount } from "./saved-accounts";
import type { UserInfo } from "./types";

export type LoginOptions = {
  /**
   * When true, the password is encrypted and stored with the saved account so
   * loginSaved can silently re-login after token expiry. Defaults to false.
   */
  rememberPassword?: boolean;
};

export type AuthState = {
  token: string | null;
  user: UserInfo | null;
  ready: boolean;
  /** True while startup is restoring a persisted session / remembered password. */
  restoringSession: boolean;
  savedAccounts: SavedLoginAccount[];
  login(username: string, password: string, options?: LoginOptions): Promise<void>;
  loginSaved(accountId: string): Promise<void>;
  forgetSavedAccount(accountId: string): Promise<void>;
  /** Strip encryptedPassword from a saved account so stale secrets cannot silent-relogin. */
  clearSavedPassword(accountId: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
};

export const AuthContext = createContext<AuthState | null>(null);
