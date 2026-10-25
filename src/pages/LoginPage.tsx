import { Eye, EyeOff, Settings2, Trash2, UserRoundPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { LoadingState } from "../components/DataState";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { Button, Input } from "../components/ui";
import { getTransportBlockReason } from "../lib/api";
import { getRuntimeSettings } from "../lib/app-settings";
import { getSavedAccountLabel } from "../lib/saved-accounts";
import { useI18n } from "../lib/i18n";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";

type RouteLocationState = { from?: { pathname?: string; search?: string; hash?: string } } | null;

// Task list filters, search text, sort, and page number all live in the URL query, so restoring
// only the pathname would silently discard the view the user was actually working in.
function resolvePostLoginTarget(state: unknown): string {
  const from = (state as RouteLocationState)?.from;
  const pathname = from?.pathname ?? "";
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return "/dashboard";
  if (pathname === "/login") return "/dashboard";
  return `${pathname}${from?.search ?? ""}${from?.hash ?? ""}`;
}

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

function readApiHost() {
  try {
    return new URL(getRuntimeSettings().apiBaseUrl).host;
  } catch {
    return "";
  }
}

export function LoginPage() {
  const auth = useAuth();
  const { t, text, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const confirm = useConfirmAction();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedLoginId, setSavedLoginId] = useState<string | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const hasSavedAccounts = auth.savedAccounts.length > 0;
  const showSavedAccounts = hasSavedAccounts && !showPasswordForm;
  const transportBlocked = Boolean(getTransportBlockReason());
  const apiHost = readApiHost();

  if (!auth.ready || auth.restoringSession) return <LoadingState label={t("login.restoreSession")} />;
  if (auth.token) return <Navigate to={resolvePostLoginTarget(location.state)} replace />;

  function navigateAfterLogin() {
    navigate(resolvePostLoginTarget(location.state), { replace: true });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (getTransportBlockReason()) {
      setError(t("login.transportBlocked"));
      return;
    }
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
    if (getTransportBlockReason()) {
      setError(t("login.transportBlocked"));
      return;
    }
    setSavedLoginId(accountId);
    try {
      await auth.loginSaved(accountId);
      navigateAfterLogin();
    } catch (nextError) {
      const raw = nextError instanceof Error ? nextError.message : t("login.savedLoginFailed");
      setError(friendlyLoginError(raw, "使用保存凭据登录失败，请重新输入密码", "Automatic sign-in failed. Please re-enter your password.", locale));
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
    <main className="flex h-full min-w-0 flex-col items-center overflow-x-hidden overflow-y-auto overscroll-contain bg-app-bg px-4 py-10 text-app-text sm:px-6">
      <div className="my-auto flex w-full min-w-0 max-w-[360px] flex-col">
        <div className="mb-7 flex flex-col items-center text-center">
          <img src="/favicon.svg" alt="" className="h-14 w-14" draggable={false} />
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.02em]">EasyConsole</h1>
          <p className="mt-1 text-sm text-app-muted">{t("login.tagline")}</p>
        </div>
        <section className="app-surface-enter box-border w-full min-w-0 rounded-lg border border-app-border bg-app-surface p-6 shadow-popover">
          <div className="mb-6">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-[-0.01em]">{showSavedAccounts ? t("login.chooseSavedTitle") : t("login.passwordTitle")}</h2>
              <Link
                className="app-interactive -mr-2 -mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-app-muted hover:bg-app-panel hover:text-app-text"
                to="/login/settings"
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t("common.apiSettings")}
              </Link>
            </div>
            <p className="mt-1 text-sm text-app-muted">
              {showSavedAccounts ? t("login.chooseSavedDescription") : t("login.passwordDescription")}
            </p>
            {/* Several consoles can be configured; say which one this sign-in goes to. */}
            {apiHost ? (
              <p className="mt-1 truncate text-xs text-app-muted" title={apiHost}>
                {text("登录到 ", "Signing in to ")}
                <span className="font-mono text-app-text">{apiHost}</span>
              </p>
            ) : null}
            {auth.sessionExpired ? (
              <div className="mt-3 rounded-md bg-app-warningSoft px-3 py-2 text-sm text-app-warningText" role="status">{t("login.sessionExpired")}</div>
            ) : null}
            {transportBlocked ? (
              <div className="mt-3 rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{t("login.transportBlocked")}</div>
            ) : null}
          </div>

          {showSavedAccounts ? (
            <div className="space-y-4">
              <div className="space-y-2">
                {auth.savedAccounts.map((account) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md border border-app-border bg-app-bg px-3 py-2.5"
                    key={account.id}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-accentSoft text-sm font-semibold text-app-accent" aria-hidden="true">
                      {getSavedAccountLabel(account).trim().charAt(0).toUpperCase() || "?"}
                    </span>
                    <div className="min-w-0 flex-1">
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
              {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger" role="alert">{error}</div> : null}
              <Button
                className="w-full"
                onClick={() => {
                  setError(null);
                  setUsername("");
                  setPassword("");
                  setRememberPassword(false);
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
                <span className="mb-1.5 block font-medium text-app-text">{t("login.username")}</span>
                <Input
                  autoComplete="username"
                  className="w-full"
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium text-app-text">{t("login.password")}</span>
                <div className="relative">
                  <Input
                    autoComplete="current-password"
                    className="w-full pr-10"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type={showPassword ? "text" : "password"}
                    value={password}
                  />
                  <button
                    type="button"
                    className="app-interactive absolute inset-y-0 right-0 flex w-10 items-center justify-center text-app-muted hover:text-app-text"
                    aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              <label className="flex items-center gap-2 text-xs text-app-muted">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(event) => setRememberPassword(event.target.checked)}
                />
                {t("login.rememberPassword")}
              </label>
              {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger" role="alert">{error}</div> : null}
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
        </section>
        <p className="mt-6 px-2 text-center text-xs leading-5 text-app-muted">{t("login.heroCopy")}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <LanguageSwitch compact />
          <ThemeSwitch />
        </div>
      </div>
      {confirm.confirmDialog}
    </main>
  );
}
