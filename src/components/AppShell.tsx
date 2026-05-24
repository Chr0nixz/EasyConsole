import { CalendarClock, Command as CommandIcon, Database, Image, LayoutDashboard, LogOut, ScrollText, Server, Settings, SquareStack, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { LanguageSwitch } from "./LanguageSwitch";
import { BackgroundScheduledTaskRunner } from "./BackgroundScheduledTaskRunner";
import { CommandPalette } from "./CommandPalette";
import { TaskNotificationWatcher } from "./TaskNotificationWatcher";
import { Button } from "./ui";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useAuth } from "../lib/use-auth";
import { cn } from "../lib/utils";

const navItems = [
  { to: "/dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { to: "/tasks", labelKey: "nav.tasks", icon: Server },
  { to: "/scheduled-tasks", labelKey: "nav.scheduledTasks", icon: CalendarClock },
  { to: "/task-templates", labelKey: "nav.taskTemplates", icon: SquareStack },
  { to: "/storage", labelKey: "nav.storage", icon: Database },
  { to: "/images", labelKey: "nav.images", icon: Image },
  { to: "/run-logs", labelKey: "nav.runLogs", icon: ScrollText },
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
] as const;

const titles: Record<string, TranslationKey> = {
  "/dashboard": "title.dashboard",
  "/tasks": "title.tasks",
  "/scheduled-tasks": "title.scheduledTasks",
  "/task-templates": "title.taskTemplates",
  "/storage": "title.storage",
  "/images": "title.images",
  "/run-logs": "title.runLogs",
  "/settings": "title.settings",
};

export function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const { t } = useI18n();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const userName = auth.user?.username || auth.user?.name || t("shell.loggedIn");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-bg text-app-text md:flex-row">
      <TaskNotificationWatcher />
      <BackgroundScheduledTaskRunner />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <aside className="hidden h-screen w-60 shrink-0 flex-col overflow-hidden border-r border-app-border bg-app-surface md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-app-border px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-app-accent text-app-onAccent">
            <TerminalSquare className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">EasyConsole</div>
            <div className="text-xs text-app-muted">{t("shell.productSubtitle")}</div>
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
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 md:px-5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{t(titles[location.pathname] ?? "common.console")}</h1>
            <p className="hidden truncate text-xs text-app-muted sm:block">{t("shell.headerDescription")}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button className="hidden shrink-0 sm:inline-flex" variant="secondary" onClick={() => setCommandPaletteOpen(true)}>
              <CommandIcon className="h-4 w-4" />
              Ctrl K
            </Button>
            <LanguageSwitch />
            <span className="hidden max-w-32 truncate text-sm text-app-muted sm:inline md:max-w-48">{userName}</span>
            <Button className="shrink-0" variant="secondary" onClick={() => void auth.logout()}>
              <LogOut className="h-4 w-4" />
              {t("shell.logout")}
            </Button>
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-4 pb-24 sm:p-5 sm:pb-24 md:pb-5">
          <div key={location.pathname} className="app-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto border-t border-app-border bg-app-surface md:hidden">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "app-interactive flex h-16 min-w-20 flex-col items-center justify-center gap-1 text-xs text-app-muted",
                isActive && "bg-app-accentSoft text-app-accent",
              )
            }
          >
            <item.icon className="h-5 w-5" />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
