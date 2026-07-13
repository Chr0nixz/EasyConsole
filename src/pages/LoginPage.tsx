import { LockKeyhole, Server, Trash2, UserCheck, UserRoundPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { LoadingState } from "../components/DataState";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { Button, Input } from "../components/ui";
import { getSavedAccountLabel } from "../lib/saved-accounts";
import { useI18n } from "../lib/i18n";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";

function friendlyLoginError(message: string, fallbackZh: string, fallbackEn: string, locale: "zh-CN" | "en-US") {
  const lower = message.toLowerCase();
  const zh = locale === "zh-CN";
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("failed to fetch") || lower.includes("err_network")) {
    return zh ? "网络连接异常，请检查网络后重试。" : "Network error. Check your connection and try again.";
  }
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return zh ? "用户名或密码不正确。" : "Username or password is incorrect.";
  }
  if (lower.includes("timeout")) {
    return zh ? "请求超时，请稍后重试。" : "Request timed out. Please try again.";
  }
  if (lower.includes("500") || lower.includes("server")) {
    return zh ? "服务器异常，请稍后重试或联系管理员。" : "Server error. Try again later or contact an administrator.";
  }
  // Preserve domain-specific messages (e.g. "Sign-in response did not include a token") but still keep them readable.
  return message || (zh ? fallbackZh : fallbackEn);
}

export function LoginPage() {
  const auth = useAuth();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirmAction();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedLoginId, setSavedLoginId] = useState<string | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const hasSavedAccounts = auth.savedAccounts.length > 0;
  const showSavedAccounts = hasSavedAccounts && !showPasswordForm;

  if (!auth.ready) return <LoadingState label={t("login.restoreSession")} />;
  if (auth.token) return <Navigate to="/dashboard" replace />;

  function navigateAfterLogin() {
    const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/dashboard";
    navigate(from, { replace: true });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await auth.login(username, password, { rememberPassword });
      navigateAfterLogin();
    } catch (nextError) {
      const raw = nextError instanceof Error ? nextError.message : t("login.failed");
      setError(friendlyLoginError(raw, "登录失败", "Sign-in failed", locale));
    } finally {
      setLoading(false);
    }
  }

  async function onSavedLogin(accountId: string) {
    setError(null);
    setSavedLoginId(accountId);
    try {
      await auth.loginSaved(accountId);
      navigateAfterLogin();
    } catch (nextError) {
      const raw = nextError instanceof Error ? nextError.message : t("login.savedLoginFailed");
      setError(friendlyLoginError(raw, "直接登录失败，请重新输入密码", "Saved sign-in failed. Enter the password again.", locale));
      const account = auth.savedAccounts.find((item) => item.id === accountId);
      if (account) setUsername(account.username);
      setShowPasswordForm(true);
    } finally {
      setSavedLoginId(null);
    }
  }

  function onForgetSavedAccount(accountId: string, label: string) {
    setError(null);
    confirm.confirm({
      title: t("login.forgetTitle"),
      description: t("login.forgetDescription"),
      confirmLabel: t("login.forgetConfirmLabel"),
      tone: "danger",
      run: () => auth.forgetSavedAccount(accountId).then(() => {
        // Remove succeeded; nothing else to do. The list updates via auth context.
        void label;
      }),
    });
  }

  return (
    <main className="grid min-h-screen min-w-0 grid-cols-[minmax(0,1fr)] overflow-x-hidden bg-app-bg text-app-text lg:grid-cols-[minmax(0,1fr)_460px]">
      <section className="hidden flex-col justify-between border-r border-app-border bg-app-surface p-10 lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-app-accent text-app-onAccent">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">EasyConsole</h1>
            <p className="text-sm text-app-muted">{t("login.tagline")}</p>
          </div>
        </div>
        <div className="max-w-xl">
          <p className="text-sm leading-6 text-app-muted">
            {t("login.heroCopy")}
          </p>
        </div>
      </section>
      <section className="flex min-w-0 items-center justify-center overflow-x-hidden px-4 py-10 sm:px-6">
        <div className="app-surface-enter box-border w-full min-w-0 max-w-[320px] rounded-lg border border-app-border bg-app-surface p-6 shadow-shell sm:max-w-sm">
          <div className="mb-6">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-app-accentSoft text-app-accent">
                {showSavedAccounts ? <UserCheck className="h-5 w-5" /> : <LockKeyhole className="h-5 w-5" />}
              </div>
              <Link
                className="app-interactive rounded-md px-2 py-1 text-xs text-app-muted hover:bg-app-panel hover:text-app-text"
                to="/login/settings"
              >
                {t("common.apiSettings")}
              </Link>
            </div>
            <h2 className="text-lg font-semibold">{showSavedAccounts ? t("login.chooseSavedTitle") : t("login.passwordTitle")}</h2>
            <p className="mt-1 text-sm text-app-muted">
              {showSavedAccounts ? t("login.chooseSavedDescription") : t("login.passwordDescription")}
            </p>
          </div>

          {showSavedAccounts ? (
            <div className="space-y-4">
              <div className="space-y-2">
                {auth.savedAccounts.map((account) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border border-app-border bg-app-bg px-3 py-2"
                    key={account.id}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{getSavedAccountLabel(account)}</div>
                      <div className="truncate text-xs text-app-muted">{account.username}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        className="h-8 px-2"
                        disabled={savedLoginId === account.id}
                        onClick={() => void onSavedLogin(account.id)}
                        type="button"
                      >
                        {savedLoginId === account.id ? t("login.signingIn") : t("login.savedSignIn")}
                      </Button>
                      <Button
                        aria-label={t("login.removeSavedAccount", { account: getSavedAccountLabel(account) })}
                        className="h-8 w-8 px-0"
                        onClick={() => onForgetSavedAccount(account.id, getSavedAccountLabel(account))}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{error}</div> : null}
              <Button
                className="w-full"
                onClick={() => {
                  setError(null);
                  setUsername("");
                  setPassword("");
                  setRememberPassword(true);
                  setShowPasswordForm(true);
                }}
                type="button"
                variant="secondary"
              >
                <UserRoundPlus className="h-4 w-4" />
                {t("login.switchAccount")}
              </Button>
              <p className="text-xs leading-5 text-app-muted">{t("login.savedAccountNote")}</p>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{t("login.username")}</span>
                <Input
                  autoComplete="username"
                  className="w-full"
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">{t("login.password")}</span>
                <Input
                  autoComplete="current-password"
                  className="w-full"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-app-muted">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(event) => setRememberPassword(event.target.checked)}
                />
                {t("login.rememberPassword")}
              </label>
              {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{error}</div> : null}
              <div className="flex flex-col gap-2">
                <Button className="w-full" disabled={loading}>
                  {loading ? t("login.signingIn") : t("login.signIn")}
                </Button>
                {hasSavedAccounts ? (
                  <Button
                    className="w-full"
                    onClick={() => {
                      setError(null);
                      setShowPasswordForm(false);
                    }}
                    type="button"
                    variant="ghost"
                  >
                    {t("login.returnSavedAccounts")}
                  </Button>
                ) : null}
              </div>
            </form>
          )}
          <div className="mt-5 flex justify-center">
            <LanguageSwitch compact />
          </div>
        </div>
      </section>
      {confirm.confirmDialog}
    </main>
  );
}
