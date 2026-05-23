import { LockKeyhole, Server, Trash2, UserCheck, UserRoundPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { LoadingState } from "../components/DataState";
import { Button, Input } from "../components/ui";
import { getSavedAccountLabel } from "../lib/saved-accounts";
import { useAuth } from "../lib/use-auth";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedLoginId, setSavedLoginId] = useState<string | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const hasSavedAccounts = auth.savedAccounts.length > 0;
  const showSavedAccounts = hasSavedAccounts && !showPasswordForm;

  if (!auth.ready) return <LoadingState label="正在恢复登录状态" />;
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
      await auth.login(username, password);
      navigateAfterLogin();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "登录失败");
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
      setError(nextError instanceof Error ? nextError.message : "直接登录失败，请重新输入密码");
      const account = auth.savedAccounts.find((item) => item.id === accountId);
      if (account) setUsername(account.username);
      setShowPasswordForm(true);
    } finally {
      setSavedLoginId(null);
    }
  }

  async function onForgetSavedAccount(accountId: string) {
    setError(null);
    await auth.forgetSavedAccount(accountId);
  }

  return (
    <main className="grid min-h-screen min-w-0 grid-cols-[minmax(0,1fr)] overflow-x-hidden bg-app-bg text-app-text lg:grid-cols-[minmax(0,1fr)_460px]">
      <section className="hidden flex-col justify-between border-r border-app-border bg-app-surface p-10 lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-app-accent text-white">
            <Server className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">EasyConsole</h1>
            <p className="text-sm text-app-muted">任务、终端、文件和镜像的统一工作台</p>
          </div>
        </div>
        <div className="max-w-xl">
          <p className="text-sm leading-6 text-app-muted">
            用一个工作台接管任务启动、日志终端、文件传输和镜像查看，登录后即可继续日常操作。
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
                设置
              </Link>
            </div>
            <h2 className="text-lg font-semibold">{showSavedAccounts ? "选择账号登录" : "登录控制台"}</h2>
            <p className="mt-1 text-sm text-app-muted">
              {showSavedAccounts ? "使用上次登录保存的账号，或切换到其他账号。" : "使用原控制面板账号继续。"}
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
                        {savedLoginId === account.id ? "登录中" : "直接登录"}
                      </Button>
                      <Button
                        aria-label={`移除 ${getSavedAccountLabel(account)} 的保存记录`}
                        className="h-8 w-8 px-0"
                        onClick={() => void onForgetSavedAccount(account.id)}
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
                  setShowPasswordForm(true);
                }}
                type="button"
                variant="secondary"
              >
                <UserRoundPlus className="h-4 w-4" />
                切换账号
              </Button>
              <p className="text-xs leading-5 text-app-muted">保存记录不包含密码。直接登录会复用本机保存的登录令牌。</p>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">用户名</span>
                <Input
                  autoComplete="username"
                  className="w-full"
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-app-muted">密码</span>
                <Input
                  autoComplete="current-password"
                  className="w-full"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              {error ? <div className="rounded-md bg-app-dangerSoft px-3 py-2 text-sm text-app-danger">{error}</div> : null}
              <div className="flex flex-col gap-2">
                <Button className="w-full" disabled={loading}>
                  {loading ? "正在登录" : "登录"}
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
                    返回保存账号
                  </Button>
                ) : null}
              </div>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
