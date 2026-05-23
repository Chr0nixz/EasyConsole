import { CalendarClock, Database, Image, LayoutDashboard, LogOut, Server, Settings, SquareStack, TerminalSquare } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { Button } from "./ui";
import { useAuth } from "../lib/use-auth";
import { cn } from "../lib/utils";

const navItems = [
  { to: "/dashboard", label: "总览", icon: LayoutDashboard },
  { to: "/tasks", label: "任务实例", icon: Server },
  { to: "/scheduled-tasks", label: "定时任务", icon: CalendarClock },
  { to: "/task-templates", label: "实例模板", icon: SquareStack },
  { to: "/storage", label: "文件存储", icon: Database },
  { to: "/images", label: "镜像", icon: Image },
  { to: "/settings", label: "设置", icon: Settings },
];

const titles: Record<string, string> = {
  "/dashboard": "运行总览",
  "/tasks": "任务实例",
  "/scheduled-tasks": "定时任务",
  "/task-templates": "实例模板",
  "/storage": "文件存储",
  "/images": "镜像管理",
  "/settings": "系统设置",
};

export function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const userName = auth.user?.username || auth.user?.name || "已登录";

  return (
    <div className="flex min-h-screen flex-col bg-app-bg text-app-text md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-app-border bg-app-surface md:flex">
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
                  "app-interactive flex h-9 items-center gap-2 rounded-md px-3 text-sm text-app-muted hover:bg-app-panel hover:text-app-text",
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
        <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 md:px-5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{titles[location.pathname] ?? "控制台"}</h1>
            <p className="hidden truncate text-xs text-app-muted sm:block">集中查看任务、存储、镜像与终端状态</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden max-w-32 truncate text-sm text-app-muted sm:inline md:max-w-48">{userName}</span>
            <Button className="shrink-0" variant="secondary" onClick={() => void auth.logout()}>
              <LogOut className="h-4 w-4" />
              退出
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-auto px-3 py-4 pb-24 sm:p-5 sm:pb-24 md:pb-5">
          <div key={location.pathname} className="app-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid border-t border-app-border bg-app-surface md:hidden"
        style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "app-interactive flex h-16 flex-col items-center justify-center gap-1 text-xs text-app-muted",
                isActive && "bg-app-accentSoft text-app-accent",
              )
            }
          >
            <item.icon className="h-5 w-5" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
