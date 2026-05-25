import { CalendarClock, Command as CommandIcon, Database, DownloadCloud, Image, LayoutDashboard, LogOut, Minimize2, Power, ScrollText, Server, Settings, SquareStack, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { LanguageSwitch } from "./LanguageSwitch";
import { BackgroundScheduledTaskRunner } from "./BackgroundScheduledTaskRunner";
import { CommandPalette } from "./CommandPalette";
import { TaskNotificationWatcher } from "./TaskNotificationWatcher";
import { Button, Dialog } from "./ui";
import { APP_SETTINGS_STORAGE_KEY, getRuntimeSettings, setRuntimeSettings, stringifyAppSettings } from "../lib/app-settings";
import { useAppUpdate } from "../lib/app-update-context";
import { browserRuntime } from "../lib/runtime";
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
  const { t, text } = useI18n();
  const appUpdate = useAppUpdate();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);
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

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | null = null;
    void browserRuntime.onDesktopCloseRequested(() => {
      setClosePromptOpen((open) => {
        if (!open) setRememberCloseChoice(false);
        return true;
      });
    }).then((remove) => {
      if (disposed) {
        remove();
        return;
      }
      removeListener = remove;
    });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);

  function closeClosePrompt() {
    setClosePromptOpen(false);
    setRememberCloseChoice(false);
    void browserRuntime.cancelDesktopClosePrompt();
  }

  async function chooseCloseAction(action: "tray" | "exit") {
    if (rememberCloseChoice) {
      const nextSettings = {
        ...getRuntimeSettings(),
        desktopClosePrompt: false,
        desktopCloseToTray: action === "tray",
      };
      setRuntimeSettings(nextSettings);
      await browserRuntime.storage.set(APP_SETTINGS_STORAGE_KEY, stringifyAppSettings(nextSettings));
      await browserRuntime.setDesktopClosePrompt(false);
      await browserRuntime.setDesktopCloseToTray(nextSettings.desktopCloseToTray);
    }

    setClosePromptOpen(false);
    setRememberCloseChoice(false);
    await browserRuntime.completeDesktopClosePrompt(action);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-bg text-app-text md:flex-row">
      <TaskNotificationWatcher />
      <BackgroundScheduledTaskRunner />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <Dialog
        open={closePromptOpen}
        title={text("关闭 EasyConsole", "Close EasyConsole")}
        onClose={closeClosePrompt}
        width="max-w-md"
        closeOnOverlayClick={false}
      >
        <div className="space-y-4 p-4">
          <p className="text-sm leading-6 text-app-muted">
            {text(
              "要彻底退出应用，还是最小化到托盘继续执行后台计划任务？",
              "Exit the app completely, or minimize to tray so background scheduled tasks can continue?",
            )}
          </p>
          <label className="flex items-center gap-2 text-sm text-app-muted">
            <input
              type="checkbox"
              checked={rememberCloseChoice}
              onChange={(event) => setRememberCloseChoice(event.target.checked)}
            />
            {text("不再提示，记住本次选择", "Do not ask again, remember this choice")}
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={closeClosePrompt}>
              {text("继续使用", "Keep open")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => void chooseCloseAction("tray")}>
              <Minimize2 className="h-4 w-4" />
              {text("最小化到托盘", "Minimize to tray")}
            </Button>
            <Button type="button" variant="danger" onClick={() => void chooseCloseAction("exit")}>
              <Power className="h-4 w-4" />
              {text("彻底退出", "Exit")}
            </Button>
          </div>
        </div>
      </Dialog>
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
            {browserRuntime.isDesktop && (appUpdate.state.status === "available" || appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading") ? (
              <Button className="shrink-0" variant="secondary" onClick={appUpdate.openUpdateDialog}>
                <DownloadCloud className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {appUpdate.state.status === "readyToRestart" ? text("重启更新", "Restart update") : text("更新", "Update")}
                </span>
              </Button>
            ) : null}
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
