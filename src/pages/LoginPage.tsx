import { LockKeyhole, Server } from "lucide-react";
import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { Button, Input } from "../components/ui";
import { LoadingState } from "../components/DataState";
import { useAuth } from "../lib/use-auth";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!auth.ready) return <LoadingState label="正在恢复登录状态" />;
  if (auth.token) return <Navigate to="/dashboard" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await auth.login(username, password);
      const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/dashboard";
      navigate(from, { replace: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen grid-cols-1 bg-app-bg text-app-text lg:grid-cols-[1fr_440px]">
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
            面向远端控制面板 API 的轻量替代界面。首版聚焦日常任务管理，并保留后续 Tauri 打包所需的运行时边界。
          </p>
        </div>
      </section>
      <section className="flex items-center justify-center px-6">
        <form className="w-full max-w-sm rounded-lg border border-app-border bg-app-surface p-6 shadow-shell" onSubmit={onSubmit}>
          <div className="mb-6">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-app-accentSoft text-app-accent">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-semibold">登录控制台</h2>
            <p className="mt-1 text-sm text-app-muted">使用原控制面板账号继续</p>
          </div>
          <div className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">用户名</span>
              <Input className="w-full" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-app-muted">密码</span>
              <Input
                className="w-full"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
            <Button className="w-full" disabled={loading}>
              {loading ? "正在登录" : "登录"}
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
