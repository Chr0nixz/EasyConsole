import { Database, Image, LayoutDashboard, LogOut, Server, TerminalSquare } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { Button } from "./ui";
import { useAuth } from "../lib/use-auth";
import { cn } from "../lib/utils";

const navItems = [
  { to: "/dashboard", label: "总览", icon: LayoutDashboard },
  { to: "/tasks", label: "任务实例", icon: Server },
  { to: "/storage", label: "文件存储", icon: Database },
  { to: "/images", label: "镜像", icon: Image },
];

const titles: Record<string, string> = {
  "/dashboard": "运行总览",
  "/tasks": "任务实例",
  "/storage": "文件存储",
  "/images": "镜像管理",
};

export function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const userName = auth.user?.username || auth.user?.name || "已登录";

  return (
    <div className="flex min-h-screen bg-app-bg text-app-text">
      <aside className="flex w-60 shrink-0 flex-col border-r border-app-border bg-app-surface">
        <div className="flex h-14 items-center gap-2 border-b border-app-border px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-app-accent text-white">
            <TerminalSquare className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">EasyConsole</div>
            <div className="text-xs text-app-muted">任务控制台</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm text-app-muted transition hover:bg-app-panel hover:text-app-text",
                  isActive && "bg-app-accentSoft text-app-accent",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-app-border bg-app-surface px-5">
          <div>
            <h1 className="text-base font-semibold">{titles[location.pathname] ?? "控制台"}</h1>
            <p className="text-xs text-app-muted">连接远端 API，保留 Tauri 运行时替换边界</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="max-w-48 truncate text-sm text-app-muted">{userName}</span>
            <Button variant="secondary" onClick={() => void auth.logout()}>
              <LogOut className="h-4 w-4" />
              退出
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-auto p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
