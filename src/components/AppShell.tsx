import { CalendarClock, Command as CommandIcon, Database, DownloadCloud, ExternalLink, FolderOpen, Image, LayoutDashboard, LogOut, Minimize2, MoreHorizontal, Power, RotateCcw, Save, ScrollText, Search, Server, Settings, SquareStack, TerminalSquare, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { LanguageSwitch } from "./LanguageSwitch";
import { BackgroundScheduledTaskRunner } from "./BackgroundScheduledTaskRunner";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TaskNotificationWatcher } from "./TaskNotificationWatcher";
import { Button, Dialog } from "./ui";
import { GLOBAL_SETTINGS_ACCOUNT_ID, getRuntimeSettings, saveAccountSettings, setRuntimeSettings } from "../lib/app-settings";
import { useAppUpdate } from "../lib/app-update-context";
import { useCommitQueue } from "../lib/commit-queue-context";
import { downloadStatusText } from "../lib/download-queue";
import { formatDownloadProgress, useDownloadQueue } from "../lib/download-queue-context";
import { browserRuntime } from "../lib/runtime";
import { resolveSavedAccountId } from "../lib/saved-accounts";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";
import {
  DEFAULT_SHELL_NAV_WIDTH,
  clampShellNavWidth,
  readStoredShellNavWidth,
  writeStoredShellNavWidth,
} from "../lib/shell-nav-width";
import { cn } from "../lib/utils";

const navItems = [
  { to: "/dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard, shortcut: "g d" },
  { to: "/tasks", labelKey: "nav.tasks", icon: Server, shortcut: "g t" },
  { to: "/scheduled-tasks", labelKey: "nav.scheduledTasks", icon: CalendarClock, shortcut: "g c" },
  { to: "/task-templates", labelKey: "nav.taskTemplates", icon: SquareStack, shortcut: "g m" },
  { to: "/storage", labelKey: "nav.storage", icon: Database, shortcut: "g s" },
  { to: "/images", labelKey: "nav.images", icon: Image, shortcut: "g i" },
  { to: "/run-logs", labelKey: "nav.runLogs", icon: ScrollText, shortcut: "g r" },
  { to: "/settings", labelKey: "nav.settings", icon: Settings, shortcut: "g e" },
] as const;

const primaryMobileNav = navItems.slice(0, 4);
const secondaryMobileNav = navItems.slice(4);

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
  const navigate = useNavigate();
  const { t, text } = useI18n();
  const appUpdate = useAppUpdate();
  const downloadQueue = useDownloadQueue();
  const commitQueue = useCommitQueue();
  const toast = useToast();
  const confirm = useConfirmAction();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [downloadQueueOpen, setDownloadQueueOpen] = useState(false);
  const [commitQueueOpen, setCommitQueueOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuPreviousFocusRef = useRef<HTMLElement | null>(null);
  const statusPopoverRef = useRef<HTMLDivElement>(null);
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  const statusPopoverPreviousFocusRef = useRef<HTMLElement | null>(null);
  const userName = auth.user?.username || auth.user?.name || t("shell.loggedIn");
  const [navWidth, setNavWidth] = useState(() => readStoredShellNavWidth());
  const navResizeSessionRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  function finishNavResize() {
    if (navResizeSessionRef.current === null) return;
    document.removeEventListener("pointermove", handleNavResizePointerMove);
    document.removeEventListener("pointerup", handleNavResizePointerUp);
    document.removeEventListener("pointercancel", handleNavResizePointerUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    navResizeSessionRef.current = null;
  }
  function handleNavResizePointerMove(event: PointerEvent) {
    const session = navResizeSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    setNavWidth(clampShellNavWidth(session.startWidth + (event.clientX - session.startX)));
  }
  function handleNavResizePointerUp(event: PointerEvent) {
    const session = navResizeSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    const nextWidth = clampShellNavWidth(session.startWidth + (event.clientX - session.startX));
    setNavWidth(nextWidth);
    writeStoredShellNavWidth(nextWidth);
    finishNavResize();
  }
  function handleNavResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    navResizeSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: navWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handleNavResizePointerMove);
    document.addEventListener("pointerup", handleNavResizePointerUp);
    document.addEventListener("pointercancel", handleNavResizePointerUp);
  }
  function handleNavResizeDoubleClick() {
    setNavWidth(DEFAULT_SHELL_NAV_WIDTH);
    writeStoredShellNavWidth(DEFAULT_SHELL_NAV_WIDTH);
  }

  function handleNavResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const STEP = 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const next = clampShellNavWidth(navWidth - STEP);
      setNavWidth(next);
      writeStoredShellNavWidth(next);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = clampShellNavWidth(navWidth + STEP);
      setNavWidth(next);
      writeStoredShellNavWidth(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setNavWidth(DEFAULT_SHELL_NAV_WIDTH);
      writeStoredShellNavWidth(DEFAULT_SHELL_NAV_WIDTH);
    }
  }

  useEffect(() => {
    let lastKeyTime = 0;
    let pendingKey: string | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT");
      if (isTyping) return;

      if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"], input[placeholder*="Search"]');
        searchInput?.focus();
        return;
      }

      const now = Date.now();
      if (pendingKey && now - lastKeyTime < 800) {
        const combo = `${pendingKey}${event.key.toLowerCase()}`;
        pendingKey = null;
        const navMap: Record<string, string> = {
          gd: "/dashboard",
          gt: "/tasks",
          gc: "/scheduled-tasks",
          gm: "/task-templates",
          gs: "/storage",
          gi: "/images",
          gr: "/run-logs",
          ge: "/settings",
        };
        const targetPath = navMap[combo];
        if (targetPath) {
          event.preventDefault();
          navigate(targetPath);
        }
        return;
      }

      if (event.key.toLowerCase() === "g" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        pendingKey = "g";
        lastKeyTime = now;
        return;
      }
      pendingKey = null;
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    setMoreMenuOpen(false);
    setStatusPopoverOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!moreMenuOpen) {
      moreMenuPreviousFocusRef.current?.focus();
      moreMenuPreviousFocusRef.current = null;
      return;
    }
    moreMenuPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = moreMenuRef.current;
    const focusable = container ? Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
    window.setTimeout(() => focusable[0]?.focus(), 0);

    const onClickOutside = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node) && event.target !== moreButtonRef.current) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMoreMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const activeElement = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const isInside = container && activeElement instanceof Node ? container.contains(activeElement) : false;
      if (!isInside) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!statusPopoverOpen) {
      statusPopoverPreviousFocusRef.current?.focus();
      statusPopoverPreviousFocusRef.current = null;
      return;
    }
    statusPopoverPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = statusPopoverRef.current;
    const focusable = container ? Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
    window.setTimeout(() => focusable[0]?.focus(), 0);

    const onClickOutside = (event: MouseEvent) => {
      if (statusPopoverRef.current && !statusPopoverRef.current.contains(event.target as Node) && event.target !== statusButtonRef.current) {
        setStatusPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setStatusPopoverOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const activeElement = document.activeElement;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const isInside = container && activeElement instanceof Node ? container.contains(activeElement) : false;
      if (!isInside) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [statusPopoverOpen]);

  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => () => finishNavResize(), []);

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
      const accountId = auth.user
        ? resolveSavedAccountId(auth.user.username ?? auth.user.name ?? "", auth.user)
        : GLOBAL_SETTINGS_ACCOUNT_ID;
      setRuntimeSettings(nextSettings);
      await saveAccountSettings(browserRuntime.storage, accountId, nextSettings);
      await browserRuntime.setDesktopClosePrompt(false);
      await browserRuntime.setDesktopCloseToTray(nextSettings.desktopCloseToTray);
    }

    setClosePromptOpen(false);
    setRememberCloseChoice(false);
    await browserRuntime.completeDesktopClosePrompt(action);
  }

  function openDownloadedPath(path: string) {
    void browserRuntime.openLocalPath(path).catch((error) => {
      toast.error(text("打开文件失败", "Failed to open file"), error instanceof Error ? error.message : text("请确认文件仍然存在。", "Check that the file still exists."));
    });
  }

  function revealDownloadedPath(path: string) {
    void browserRuntime.revealLocalPath(path).catch((error) => {
      toast.error(text("打开所在文件夹失败", "Failed to open containing folder"), error instanceof Error ? error.message : text("请确认文件仍然存在。", "Check that the file still exists."));
    });
  }

  function onLogoutClick() {
    confirm.confirm({
      title: t("shell.logoutConfirmTitle"),
      description: t("shell.logoutConfirmDescription"),
      confirmLabel: t("shell.logoutConfirmLabel"),
      tone: "danger",
      run: () => auth.logout(),
    });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app-bg text-app-text md:flex-row">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-app-surface focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-popover">
        {text("跳到主内容", "Skip to main content")}
      </a>
      <TaskNotificationWatcher />
      <BackgroundScheduledTaskRunner />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {downloadQueueOpen ? (
        <div className="fixed right-3 top-16 z-50 w-[calc(100vw-1.5rem)] max-w-xl rounded-lg border border-app-border bg-app-surface shadow-popover md:right-5" style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }} role="region" aria-label={text("下载队列", "Download queue")}>
          <div className="flex h-12 items-center justify-between border-b border-app-border px-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-app-text">{text("下载队列", "Download queue")}</div>
              <div className="text-xs text-app-muted">
                {downloadQueue.summary.total
                  ? text(
                      `${downloadQueue.summary.completed}/${downloadQueue.summary.total} 完成，${downloadQueue.summary.failed} 失败`,
                      `${downloadQueue.summary.completed}/${downloadQueue.summary.total} done, ${downloadQueue.summary.failed} failed`,
                    )
                  : text("暂无下载任务", "No downloads")}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button className="h-8 px-2 text-xs" disabled={downloadQueue.summary.completed + downloadQueue.summary.cancelled === 0} type="button" variant="ghost" onClick={downloadQueue.clearCompleted}>
                {text("清理", "Clear")}
              </Button>
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text" type="button" onClick={() => setDownloadQueueOpen(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">{t("common.close")}</span>
              </button>
            </div>
          </div>
          <div className="max-h-[min(28rem,calc(100vh-8rem))] overflow-auto p-2">
            {downloadQueue.items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-app-muted">{text("下载任务会显示在这里", "Downloads will appear here")}</div>
            ) : (
              <div className="space-y-2">
                {downloadQueue.items.map((item) => {
                  const active = item.status === "queued" || item.status === "downloading";
                  return (
                    <div key={item.id} className="rounded-md border border-app-border bg-app-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-app-text" title={item.filename}>{item.filename}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-app-muted">
                            <span>{item.sourceLabel}</span>
                            <span>{downloadStatusText(item.status)}</span>
                            <span>{formatDownloadProgress(item)}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {item.status === "failed" || item.status === "cancelled" ? (
                            <Button className="h-8 w-8 px-0" type="button" title={t("common.retry")} variant="ghost" onClick={() => downloadQueue.retry(item.id)}>
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          ) : null}
                          {browserRuntime.supportsFileReveal && item.status === "done" && item.destinationPath ? (
                            <>
                              <Button className="h-8 w-8 px-0" type="button" title={text("打开所在文件夹", "Open containing folder")} variant="ghost" onClick={() => revealDownloadedPath(item.destinationPath!)}>
                                <FolderOpen className="h-4 w-4" />
                              </Button>
                              <Button className="h-8 w-8 px-0" type="button" title={text("打开文件", "Open file")} variant="ghost" onClick={() => openDownloadedPath(item.destinationPath!)}>
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </>
                          ) : null}
                          {active ? (
                            <Button className="h-8 w-8 px-0" type="button" title={text("取消下载", "Cancel download")} variant="ghost" onClick={() => downloadQueue.cancel(item.id)}>
                              <X className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-app-panel" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}>
                        <div className="h-full bg-app-accent transition-all" style={{ width: `${item.status === "done" ? 100 : item.progress}%` }} />
                      </div>
                      {item.error ? <div className="mt-2 text-xs text-app-danger">{item.error}</div> : null}
                      {item.destinationPath ? <div className="mt-2 truncate font-mono text-xs text-app-muted" title={item.destinationPath}>{item.destinationPath}</div> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
      {commitQueueOpen ? (
        <div className="fixed right-3 top-16 z-50 w-[calc(100vw-1.5rem)] max-w-xl rounded-lg border border-app-border bg-app-surface shadow-popover md:right-5" style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }} role="region" aria-label={text("Commit 队列", "Commit queue")}>
          <div className="flex h-12 items-center justify-between border-b border-app-border px-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-app-text">{text("Commit 队列", "Commit queue")}</div>
              <div className="text-xs text-app-muted">
                {commitQueue.summary.total
                  ? text(
                      `${commitQueue.summary.completed}/${commitQueue.summary.total} 完成，${commitQueue.summary.failed} 失败`,
                      `${commitQueue.summary.completed}/${commitQueue.summary.total} done, ${commitQueue.summary.failed} failed`,
                    )
                  : text("暂无 Commit 任务", "No commits")}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button className="h-8 px-2 text-xs" disabled={commitQueue.summary.completed === 0} type="button" variant="ghost" onClick={commitQueue.clearCompleted}>
                {text("清理", "Clear")}
              </Button>
              <button className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text" type="button" onClick={() => setCommitQueueOpen(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">{t("common.close")}</span>
              </button>
            </div>
          </div>
          <div className="max-h-[min(28rem,calc(100vh-8rem))] overflow-auto p-2">
            {commitQueue.items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-app-muted">{text("Commit 任务会显示在这里", "Commits will appear here")}</div>
            ) : (
              <div className="space-y-2">
                {commitQueue.items.map((item) => {
                  const active = item.status === "queued" || item.status === "running";
                  const statusLabel = active
                    ? text("进行中", "Running")
                    : item.status === "done"
                      ? text("已完成", "Done")
                      : text("失败", "Failed");
                  return (
                    <div key={item.id} className="rounded-md border border-app-border bg-app-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-app-text" title={item.taskName}>{item.taskName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-app-muted">
                            <span>{statusLabel}</span>
                            {active ? <RotateCcw className="h-3 w-3 animate-spin" /> : null}
                          </div>
                        </div>
                      </div>
                      {item.error ? <div className="mt-2 text-xs text-app-danger">{item.error}</div> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
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
      {confirm.confirmDialog}
      <div className="relative hidden h-screen shrink-0 md:flex" style={{ width: navWidth }}>
        <aside className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-surface">
          <div className="flex h-14 items-center gap-2 border-b border-app-border px-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-app-accent text-app-onAccent">
              <TerminalSquare className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">EasyConsole</div>
              <div className="truncate text-xs text-app-muted">{t("shell.productSubtitle")}</div>
            </div>
          </div>
          <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                title={`${t(item.labelKey)} (${item.shortcut})`}
                className={({ isActive }) =>
                  cn(
                    "app-interactive flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm text-app-muted hover:bg-app-panel hover:text-app-text",
                    isActive && "bg-app-accentSoft text-app-accent",
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </nav>
        </aside>
        <div
          aria-orientation="vertical"
          aria-valuenow={navWidth}
          aria-label={t("shell.sidebar")}
          aria-keyshortcuts="ArrowLeft ArrowRight Enter"
          className="app-nav-resize-handle absolute inset-y-0 right-0 z-10 w-2 touch-none"
          role="separator"
          tabIndex={0}
          title={t("shell.sidebar")}
          onKeyDown={handleNavResizeKeyDown}
          onDoubleClick={handleNavResizeDoubleClick}
          onPointerDown={handleNavResizePointerDown}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 md:px-5" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{t(titles[location.pathname] ?? "common.console")}</h1>
            <p className="hidden truncate text-xs text-app-muted sm:block">{t("shell.headerDescription")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="relative">
              <Button
                ref={statusButtonRef}
                aria-expanded={statusPopoverOpen}
                aria-haspopup="dialog"
                aria-label={t("shell.statusLabel")}
                className="shrink-0"
                title={t("shell.statusLabel")}
                variant="secondary"
                onClick={() => setStatusPopoverOpen((value) => !value)}
              >
                <DownloadCloud className="h-4 w-4" />
                <span className="hidden sm:inline">{t("shell.status")}</span>
                {(() => {
                  const activeCount = (downloadQueue.summary.active ?? 0) + (commitQueue.summary.active ?? 0);
                  const failedCount = (downloadQueue.summary.failed ?? 0) + (commitQueue.summary.failed ?? 0);
                  const updateAvailable = browserRuntime.supportsUpdater && (appUpdate.state.status === "available" || appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading");
                  const total = activeCount + failedCount + (updateAvailable ? 1 : 0);
                  return total > 0 ? (
                    <span className="rounded bg-app-panel px-1.5 py-0.5 text-xs text-app-muted">
                      {total}
                    </span>
                  ) : null;
                })()}
              </Button>
              {statusPopoverOpen ? (
                <div
                  ref={statusPopoverRef}
                  className="fixed right-3 top-16 z-50 w-64 rounded-lg border border-app-border bg-app-surface shadow-popover md:right-5"
                  role="dialog"
                  aria-modal="true"
                  aria-label={t("shell.statusLabel")}
                  style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }}
                >
                  <div className="flex h-12 items-center justify-between border-b border-app-border px-3">
                    <div className="text-sm font-semibold text-app-text">{t("shell.statusLabel")}</div>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
                      type="button"
                      onClick={() => setStatusPopoverOpen(false)}
                    >
                      <X className="h-4 w-4" />
                      <span className="sr-only">{t("common.close")}</span>
                    </button>
                  </div>
                  <div className="p-2">
                    <button
                      className="app-interactive flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-app-panel"
                      type="button"
                      onClick={() => {
                        setDownloadQueueOpen(true);
                        setStatusPopoverOpen(false);
                      }}
                    >
                      <DownloadCloud className="h-4 w-4 shrink-0 text-app-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-app-text">{text("下载队列", "Downloads")}</span>
                        <span className="block truncate text-xs text-app-muted">
                          {downloadQueue.summary.total
                            ? text(
                                `${downloadQueue.summary.completed}/${downloadQueue.summary.total} 完成，${downloadQueue.summary.failed} 失败`,
                                `${downloadQueue.summary.completed}/${downloadQueue.summary.total} done, ${downloadQueue.summary.failed} failed`,
                              )
                            : text("暂无下载任务", "No downloads")}
                        </span>
                      </span>
                      {downloadQueue.summary.active || downloadQueue.summary.failed ? (
                        <span className="shrink-0 rounded bg-app-panel px-1.5 py-0.5 text-xs text-app-muted">
                          {downloadQueue.summary.active || downloadQueue.summary.failed}
                        </span>
                      ) : null}
                    </button>
                    <button
                      className="app-interactive flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-app-panel"
                      type="button"
                      title={t("shell.commitTooltip")}
                      onClick={() => {
                        setCommitQueueOpen(true);
                        setStatusPopoverOpen(false);
                      }}
                    >
                      <Save className="h-4 w-4 shrink-0 text-app-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-app-text">{text("Commit 队列", "Commit queue")}</span>
                        <span className="block truncate text-xs text-app-muted">
                          {commitQueue.summary.total
                            ? text(
                                `${commitQueue.summary.completed}/${commitQueue.summary.total} 完成，${commitQueue.summary.failed} 失败`,
                                `${commitQueue.summary.completed}/${commitQueue.summary.total} done, ${commitQueue.summary.failed} failed`,
                              )
                            : text("暂无 Commit 任务", "No commits")}
                        </span>
                      </span>
                      {commitQueue.summary.active || commitQueue.summary.failed ? (
                        <span className="shrink-0 rounded bg-app-panel px-1.5 py-0.5 text-xs text-app-muted">
                          {commitQueue.summary.active || commitQueue.summary.failed}
                        </span>
                      ) : null}
                    </button>
                    {browserRuntime.supportsUpdater && (appUpdate.state.status === "available" || appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading") ? (
                      <button
                        className="app-interactive flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-app-panel"
                        type="button"
                        onClick={() => {
                          appUpdate.openUpdateDialog();
                          setStatusPopoverOpen(false);
                        }}
                      >
                        <DownloadCloud className="h-4 w-4 shrink-0 text-app-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-app-text">
                            {appUpdate.state.status === "readyToRestart" ? text("重启更新", "Restart update") : text("更新", "Update")}
                          </span>
                          <span className="block truncate text-xs text-app-muted">{text("有新版本可用", "A new version is available")}</span>
                        </span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <Button className="hidden shrink-0 sm:inline-flex" variant="secondary" onClick={() => setCommandPaletteOpen(true)}>
              <CommandIcon className="h-4 w-4" />
              Ctrl K
            </Button>
            <Button
              aria-label={t("shell.shortcutsTitle")}
              className="inline-flex shrink-0 sm:hidden"
              title={t("shell.shortcutsTitle")}
              variant="secondary"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search className="h-4 w-4" />
            </Button>
            <LanguageSwitch />
            <span className="hidden max-w-32 truncate text-sm text-app-muted sm:inline md:max-w-48">{userName}</span>
            <Button className="shrink-0" variant="secondary" onClick={onLogoutClick}>
              <LogOut className="h-4 w-4" />
              {t("shell.logout")}
            </Button>
          </div>
        </header>
        {isOnline ? null : (
          <div className="flex items-center gap-2 bg-app-warningSoft px-4 py-1.5 text-sm font-medium text-app-warningText" role="alert">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span>{text("当前处于离线状态，部分功能不可用", "You are offline — some features are unavailable")}</span>
          </div>
        )}
        <main id="main-content" className="app-main-content min-h-0 min-w-0 flex-1 overflow-auto px-3 py-4 pb-32 sm:p-5 sm:pb-32 md:pb-5">
          <div key={location.pathname} className="app-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      {moreMenuOpen ? (
        <div
          ref={moreMenuRef}
          className="fixed inset-x-0 z-50 border-t border-app-border bg-app-surface shadow-popover md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={text("更多页面", "More pages")}
          style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="grid grid-cols-4 gap-0">
            {secondaryMobileNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "app-interactive flex flex-col items-center justify-center gap-1 py-3 text-xs text-app-muted",
                    isActive && "bg-app-accentSoft text-app-accent",
                  )
                }
                onClick={() => setMoreMenuOpen(false)}
              >
                <item.icon className="h-5 w-5" />
                <span>{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </div>
        </div>
      ) : null}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-app-border bg-app-surface md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {primaryMobileNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "app-interactive flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs text-app-muted",
                isActive && "bg-app-accentSoft text-app-accent",
              )
            }
          >
            <item.icon className="h-5 w-5" />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
        <button
          ref={moreButtonRef}
          type="button"
          aria-expanded={moreMenuOpen}
          aria-haspopup="dialog"
          className={cn(
            "app-interactive flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs text-app-muted",
            secondaryMobileNav.some((item) => location.pathname.startsWith(item.to)) && "bg-app-accentSoft text-app-accent",
          )}
          onClick={() => setMoreMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>{text("更多", "More")}</span>
        </button>
      </nav>
    </div>
  );
}
