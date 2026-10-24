import { AlertCircle, ArrowUpCircle, CalendarClock, Database, DownloadCloud, ExternalLink, FolderOpen, Image, LayoutDashboard, LogOut, Minimize2, MoreHorizontal, Power, RotateCcw, Save, ScrollText, Search, Server, Settings, SquareStack, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { LanguageSwitch } from "./LanguageSwitch";
import { BackgroundScheduledTaskRunner } from "./BackgroundScheduledTaskRunner";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TaskNotificationWatcher } from "./TaskNotificationWatcher";
import { ThemeSwitch } from "./ThemeSwitch";
import { Button, Dialog, ProgressBar } from "./ui";
import { GLOBAL_SETTINGS_ACCOUNT_ID, getRuntimeSettings, saveAccountSettings, setRuntimeSettings } from "../lib/app-settings";
import { getTransportBlockReason, subscribeTransportPolicy } from "../lib/api";
import { useAppUpdate } from "../lib/app-update-context";
import { useCommitQueue } from "../lib/commit-queue-context";
import { downloadStatusText } from "../lib/download-queue";
import { formatDownloadProgress, useDownloadQueue } from "../lib/use-download-queue";
import { browserRuntime } from "../lib/runtime";
import { resolveSavedAccountId } from "../lib/saved-accounts";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { useConfirmAction } from "../lib/use-confirm-action";
import { useAuth } from "../lib/use-auth";
import { useToast } from "../lib/use-toast";
import {
  DEFAULT_SHELL_NAV_WIDTH,
  MAX_SHELL_NAV_WIDTH,
  MIN_SHELL_NAV_WIDTH,
  clampShellNavWidth,
  readStoredShellNavWidth,
  writeStoredShellNavWidth,
} from "../lib/shell-nav-width";
import { cn } from "../lib/utils";
import { useMobileBackLayer } from "../lib/use-mobile-back-stack";
import { useSlidingIndicator } from "../lib/use-sliding-indicator";
import { SHOW_SHORTCUTS_EVENT } from "../lib/shell-events";
import { markTaskFailuresSeen, useUnseenTaskFailureCount } from "../lib/task-attention";
import { exitPresets, useExitGhost } from "../lib/exit-motion";
import { claimOverlayKey, hasOpenModalOverlay, useOverlay } from "../lib/overlay-stack";

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

const primaryMobileNav = navItems.slice(0, 3);
const secondaryMobileNav = navItems.slice(3);

// Sidebar sections: workloads you launch, resources they use, and EasyConsole itself.
const navGroups = [
  { id: "workloads", zh: "工作负载", en: "Workloads", items: navItems.slice(0, 4) },
  { id: "resources", zh: "资源", en: "Resources", items: navItems.slice(4, 6) },
  { id: "system", zh: "系统", en: "System", items: navItems.slice(6) },
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

const headerDescriptions: Record<string, TranslationKey> = {
  "/dashboard": "shell.desc.dashboard",
  "/tasks": "shell.desc.tasks",
  "/scheduled-tasks": "shell.desc.scheduledTasks",
  "/task-templates": "shell.desc.taskTemplates",
  "/storage": "shell.desc.storage",
  "/images": "shell.desc.images",
  "/run-logs": "shell.desc.runLogs",
  "/settings": "shell.desc.settings",
};

function headerTitleKey(pathname: string): TranslationKey {
  if (/^\/tasks\/[^/]+$/.test(pathname)) return "title.taskDetail";
  return titles[pathname] ?? "common.console";
}

function headerDescriptionKey(pathname: string): TranslationKey {
  if (/^\/tasks\/[^/]+$/.test(pathname)) return "shell.desc.taskDetail";
  return headerDescriptions[pathname] ?? "shell.headerDescription";
}

/**
 * A queue panel stays open while you work (no outside-press close), but it takes focus when it
 * opens, answers Escape, and hands focus back to the status button it was opened from.
 */
function useQueuePanel(open: boolean, panelRef: RefObject<HTMLDivElement | null>, returnFocusRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const layerRef = useOverlay(open, "popover");
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const returnTarget = returnFocusRef.current;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !claimOverlayKey(layerRef.current, event)) return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      // Focus left with the panel's own nodes; a click elsewhere keeps the focus it moved.
      const active = document.activeElement;
      if (!active || active === document.body) returnTarget?.focus();
    };
  }, [open, layerRef, panelRef, returnFocusRef]);
}

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
  const [statusPopoverPosition, setStatusPopoverPosition] = useState({ left: 12, top: 64 });
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [transportBlocked, setTransportBlocked] = useState(() => Boolean(getTransportBlockReason()));
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuPreviousFocusRef = useRef<HTMLElement | null>(null);
  const statusPopoverRef = useRef<HTMLDivElement>(null);
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  const statusPopoverPreviousFocusRef = useRef<HTMLElement | null>(null);
  const userName = auth.user?.username || auth.user?.name || t("shell.loggedIn");
  const userInitial = (auth.user?.name || auth.user?.username || "?").trim().charAt(0).toUpperCase() || "?";
  const userGroup = typeof auth.user?.user_group === "string" && auth.user.user_group ? auth.user.user_group : t("shell.loggedIn");
  const sidebarNavRef = useRef<HTMLElement>(null);
  const sidebarIndicatorRef = useRef<HTMLSpanElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const mobileIndicatorRef = useRef<HTMLSpanElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const downloadQueueRef = useRef<HTMLDivElement>(null);
  const commitQueueRef = useRef<HTMLDivElement>(null);
  const moreScrimRef = useRef<HTMLDivElement>(null);
  useExitGhost(statusPopoverOpen, statusPopoverRef, exitPresets.popover);
  useExitGhost(downloadQueueOpen, downloadQueueRef, exitPresets.popover);
  useExitGhost(commitQueueOpen, commitQueueRef, exitPresets.popover);
  useExitGhost(moreMenuOpen, moreMenuRef, exitPresets.sheet);
  useExitGhost(moreMenuOpen, moreScrimRef, exitPresets.fade);
  const commandShortcut = browserRuntime.isApplePlatform ? "⌘ K" : "Ctrl K";
  const unseenFailureCount = useUnseenTaskFailureCount();
  const unseenFailureLabel = text(`${unseenFailureCount} 个实例在你上次查看后失败`, `${unseenFailureCount} ${unseenFailureCount === 1 ? "instance" : "instances"} failed since you last looked`);
  const activeQueueCount = (downloadQueue.summary.active ?? 0) + (commitQueue.summary.active ?? 0);
  const failedQueueCount = (downloadQueue.summary.failed ?? 0) + (commitQueue.summary.failed ?? 0);
  const updatePending = browserRuntime.supportsUpdater
    && (appUpdate.state.status === "available" || appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading");
  const statusBadgeCount = activeQueueCount + failedQueueCount + (updatePending ? 1 : 0);
  // The badge is a bare number, so the button's name carries what it counts.
  const statusDetails = [
    failedQueueCount > 0 ? text(`${failedQueueCount} 项失败`, `${failedQueueCount} failed`) : null,
    activeQueueCount > 0 ? text(`${activeQueueCount} 项进行中`, `${activeQueueCount} in progress`) : null,
    updatePending ? text("有可用更新", "update available") : null,
  ].filter(Boolean).join(text("，", ", "));
  const statusButtonLabel = statusDetails
    ? text(`${t("shell.statusLabel")}：${statusDetails}`, `${t("shell.statusLabel")}: ${statusDetails}`)
    : t("shell.statusLabel");
  const secondaryRouteActive = secondaryMobileNav.some((item) => location.pathname.startsWith(item.to));
  useSlidingIndicator(sidebarNavRef, sidebarIndicatorRef, '[aria-current="page"]', location.pathname);
  useSlidingIndicator(mobileNavRef, mobileIndicatorRef, '[aria-current="page"] .app-nav-pill, [data-active="true"] .app-nav-pill', `${location.pathname}:${secondaryRouteActive}`);
  useMobileBackLayer(moreMenuOpen, () => setMoreMenuOpen(false));
  useMobileBackLayer(statusPopoverOpen, () => setStatusPopoverOpen(false));
  useMobileBackLayer(downloadQueueOpen, () => setDownloadQueueOpen(false));
  useMobileBackLayer(commitQueueOpen, () => setCommitQueueOpen(false));
  const moreMenuLayerRef = useOverlay(moreMenuOpen, "modal");
  const statusPopoverLayerRef = useOverlay(statusPopoverOpen, "popover");
  useQueuePanel(downloadQueueOpen, downloadQueueRef, statusButtonRef, () => setDownloadQueueOpen(false));
  useQueuePanel(commitQueueOpen, commitQueueRef, statusButtonRef, () => setCommitQueueOpen(false));
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

  useEffect(() => subscribeTransportPolicy(() => setTransportBlocked(Boolean(getTransportBlockReason()))), []);

  useEffect(() => {
    const onShowShortcuts = () => setShortcutsOpen(true);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, onShowShortcuts);
    return () => window.removeEventListener(SHOW_SHORTCUTS_EVENT, onShowShortcuts);
  }, []);

  useEffect(() => {
    let lastKeyTime = 0;
    let pendingKey: string | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      // An open dialog, drawer or sheet owns the keyboard: no palette, page jump or help on top of it.
      const modalOpen = hasOpenModalOverlay();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!modalOpen) setCommandPaletteOpen(true);
        return;
      }
      if (modalOpen) {
        pendingKey = null;
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
        // The search field's placeholder differs per language, so match either.
        // eslint-disable-next-line easy-console/no-bare-cjk
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

  // The page leads the document title, so browser tabs, history and screen readers name the page.
  const pageTitle = t(headerTitleKey(location.pathname));
  useEffect(() => {
    document.title = `${pageTitle} · EasyConsole`;
    return () => {
      document.title = "EasyConsole";
    };
  }, [pageTitle]);

  // Looking at the list acknowledges every new failure; opening one task acknowledges that task.
  useEffect(() => {
    if (location.pathname === "/tasks") {
      markTaskFailuresSeen();
      return;
    }
    const detail = /^\/tasks\/([^/]+)$/.exec(location.pathname);
    if (detail) markTaskFailuresSeen(decodeURIComponent(detail[1]));
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
        if (!claimOverlayKey(moreMenuLayerRef.current, event)) return;
        event.stopPropagation();
        setMoreMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0 || !claimOverlayKey(moreMenuLayerRef.current, event)) return;
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
  }, [moreMenuOpen, moreMenuLayerRef]);

  useEffect(() => {
    if (!statusPopoverOpen) {
      statusPopoverPreviousFocusRef.current?.focus();
      statusPopoverPreviousFocusRef.current = null;
      return;
    }
    statusPopoverPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const updatePosition = () => {
      const anchor = statusButtonRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const margin = 12;
      const width = Math.min(256, Math.max(0, window.innerWidth - margin * 2));
      const left = Math.min(Math.max(margin, anchor.right - width), Math.max(margin, window.innerWidth - width - margin));
      setStatusPopoverPosition({ left, top: anchor.bottom + 8 });
    };
    updatePosition();
    const container = statusPopoverRef.current;
    const focusable = container ? Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
    window.setTimeout(() => focusable[0]?.focus(), 0);

    const onClickOutside = (event: MouseEvent) => {
      if (statusPopoverRef.current && !statusPopoverRef.current.contains(event.target as Node) && !statusButtonRef.current?.contains(event.target as Node)) {
        setStatusPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!claimOverlayKey(statusPopoverLayerRef.current, event)) return;
        event.stopPropagation();
        setStatusPopoverOpen(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0 || !claimOverlayKey(statusPopoverLayerRef.current, event)) return;
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
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [statusPopoverOpen, statusPopoverLayerRef]);

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

  function handleMainScroll(event: UIEvent<HTMLElement>) {
    const header = headerRef.current;
    if (!header) return;
    const scrolled = event.currentTarget.scrollTop > 4 ? "true" : "false";
    if (header.dataset.scrolled !== scrolled) header.dataset.scrolled = scrolled;
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
    <div className="flex h-full max-h-full flex-col overflow-hidden bg-app-bg text-app-text md:flex-row">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-app-elevated focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-popover">
        {text("跳到主内容", "Skip to main content")}
      </a>
      <TaskNotificationWatcher />
      <BackgroundScheduledTaskRunner />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
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
      <div className="relative hidden h-full shrink-0 md:flex" style={{ width: navWidth }}>
        <aside className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-sidebar">
          <div className="app-sidebar-header flex h-14 shrink-0 items-center gap-2.5 px-4">
            <img src="/favicon.svg" alt="" className="h-8 w-8 shrink-0" draggable={false} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-[-0.01em]">EasyConsole</div>
              <div className="truncate text-xs text-app-muted">{t("shell.productSubtitle")}</div>
            </div>
          </div>
          <nav ref={sidebarNavRef} className="app-sidebar-nav relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3" aria-label={text("主导航", "Main navigation")}>
            <span ref={sidebarIndicatorRef} aria-hidden="true" className="app-sliding-indicator rounded-md bg-app-thumb shadow-raised" />
            {navGroups.map((group) => (
              <div key={group.id} role="group" aria-labelledby={`nav-group-${group.id}`} className="flex flex-col gap-0.5">
                <div id={`nav-group-${group.id}`} className="truncate px-3 pb-1.5 pt-4 text-[0.6875rem] font-medium text-app-muted">
                  {text(group.zh, group.en)}
                </div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={`${t(item.labelKey)} (${item.shortcut})`}
                    className={({ isActive }) =>
                      cn(
                        "app-interactive relative flex h-9 min-w-0 items-center gap-2.5 rounded-md px-3 text-sm",
                        isActive ? "font-medium text-app-text" : "text-app-muted hover:bg-app-panel hover:text-app-text",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className={cn("h-4 w-4 shrink-0 transition-colors duration-[var(--app-motion-fast)]", isActive && "text-app-accent")} />
                        <span className="truncate">{t(item.labelKey)}</span>
                        {item.to === "/tasks" && unseenFailureCount > 0 ? (
                          <span
                            className="app-numeric ml-auto min-w-5 shrink-0 rounded-full bg-app-danger px-1.5 text-center text-[0.6875rem] font-semibold leading-5 text-app-onAccent"
                            title={unseenFailureLabel}
                          >
                            {unseenFailureCount}
                            <span className="sr-only">{unseenFailureLabel}</span>
                          </span>
                        ) : null}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="shrink-0 space-y-2.5 border-t border-app-border p-3">
            <div className="flex min-w-0 items-center gap-2.5 pl-1">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-accentSoft text-sm font-semibold text-app-accent" aria-hidden="true">
                {userInitial}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-app-text" title={userName}>{userName}</div>
                <div className="truncate text-xs text-app-muted">{userGroup}</div>
              </div>
              <Button aria-label={t("shell.logout")} className="h-8 w-8 shrink-0 px-0" title={t("shell.logout")} type="button" variant="ghost" onClick={onLogoutClick}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ThemeSwitch />
              <LanguageSwitch compact />
            </div>
          </div>
        </aside>
        <div
          aria-orientation="vertical"
          aria-valuemin={MIN_SHELL_NAV_WIDTH}
          aria-valuemax={MAX_SHELL_NAV_WIDTH}
          aria-valuenow={navWidth}
          aria-label={t("shell.sidebar")}
          aria-keyshortcuts="ArrowLeft ArrowRight Enter Space"
          className="app-nav-resize-handle absolute inset-y-0 right-0 z-10 touch-none"
          role="separator"
          tabIndex={0}
          title={t("shell.sidebar")}
          onKeyDown={handleNavResizeKeyDown}
          onDoubleClick={handleNavResizeDoubleClick}
          onPointerDown={handleNavResizePointerDown}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header ref={headerRef} className="app-shell-header z-40 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 md:px-6" data-scrolled="false" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
          <div className="min-w-0">
            <h1 className="truncate text-[1.0625rem] font-semibold leading-6 tracking-[-0.015em]">{pageTitle}</h1>
            <p className="hidden truncate text-xs text-app-muted sm:block">{t(headerDescriptionKey(location.pathname))}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              aria-keyshortcuts={browserRuntime.isApplePlatform ? "Meta+K" : "Control+K"}
              aria-label={text("搜索命令和页面", "Search commands and pages")}
              className="app-interactive flex h-9 w-9 items-center justify-center gap-2 rounded-md border border-transparent text-sm text-app-muted hover:bg-app-panel hover:text-app-text sm:w-56 sm:justify-start sm:border-app-borderStrong sm:bg-app-surface sm:px-3 sm:shadow-raised sm:hover:border-app-muted sm:hover:bg-app-surface lg:w-64 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 sm:[@media(pointer:coarse)]:w-56"
              title={text(`搜索命令和页面（${commandShortcut}）`, `Search commands and pages (${commandShortcut})`)}
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="hidden min-w-0 flex-1 truncate text-left sm:block">{text("搜索或跳转…", "Search or jump to…")}</span>
              <kbd className="hidden shrink-0 rounded border border-app-border bg-app-panel px-1.5 font-sans text-[0.6875rem] font-medium leading-5 text-app-muted sm:block">{commandShortcut}</kbd>
            </button>
            <div className="relative">
              <Button
                ref={statusButtonRef}
                aria-expanded={statusPopoverOpen}
                aria-haspopup="dialog"
                aria-label={statusButtonLabel}
                className="relative shrink-0 px-2.5"
                title={statusButtonLabel}
                variant="ghost"
                onClick={() => {
                  if (!statusPopoverOpen) {
                    const anchor = statusButtonRef.current?.getBoundingClientRect();
                    if (anchor) {
                      const margin = 12;
                      const width = Math.min(256, Math.max(0, window.innerWidth - margin * 2));
                      const left = Math.min(Math.max(margin, anchor.right - width), Math.max(margin, window.innerWidth - width - margin));
                      setStatusPopoverPosition({ left, top: anchor.bottom + 8 });
                    }
                  }
                  setStatusPopoverOpen((value) => !value);
                }}
              >
                {/* A failure changes the icon's shape, not only the badge's fill. */}
                {failedQueueCount > 0 ? <AlertCircle className="h-4 w-4 text-app-danger" /> : <DownloadCloud className="h-4 w-4" />}
                <span className="hidden lg:inline">{t("shell.status")}</span>
                {statusBadgeCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "app-numeric min-w-5 rounded-full px-1.5 text-center text-[0.6875rem] font-semibold leading-5",
                      failedQueueCount > 0 ? "bg-app-danger text-app-onAccent" : "bg-app-accent text-app-onAccent",
                    )}
                  >
                    {statusBadgeCount}
                  </span>
                ) : null}
              </Button>
              {statusPopoverOpen ? (
                <div
                  ref={statusPopoverRef}
                  className="app-pop-enter fixed z-50 w-[min(16rem,calc(100vw-1.5rem))] origin-top-right rounded-lg border border-app-border bg-app-elevated shadow-popover"
                  role="dialog"
                  aria-label={t("shell.statusLabel")}
                  style={statusPopoverPosition}
                >
                  <div className="flex h-12 items-center justify-between border-b border-app-border px-3">
                    <div className="text-sm font-semibold text-app-text">{t("shell.statusLabel")}</div>
                    <button
                      className="app-interactive flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
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
                        setCommitQueueOpen(false);
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
                        setDownloadQueueOpen(false);
                        setStatusPopoverOpen(false);
                      }}
                    >
                      <Save className="h-4 w-4 shrink-0 text-app-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-app-text">{text("提交队列", "Commit queue")}</span>
                        <span className="block truncate text-xs text-app-muted">
                          {commitQueue.summary.total
                            ? text(
                                `${commitQueue.summary.completed}/${commitQueue.summary.total} 完成，${commitQueue.summary.failed} 失败`,
                                `${commitQueue.summary.completed}/${commitQueue.summary.total} done, ${commitQueue.summary.failed} failed`,
                              )
                            : text("暂无提交任务", "No commits")}
                        </span>
                      </span>
                      {commitQueue.summary.active || commitQueue.summary.failed ? (
                        <span className="shrink-0 rounded bg-app-panel px-1.5 py-0.5 text-xs text-app-muted">
                          {commitQueue.summary.active || commitQueue.summary.failed}
                        </span>
                      ) : null}
                    </button>
                    {updatePending ? (
                      <button
                        className={cn(
                          "app-interactive flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-app-panel",
                          appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading"
                            ? "bg-app-accentSoft/40 ring-1 ring-inset ring-app-accent/25"
                            : null,
                        )}
                        type="button"
                        onClick={() => {
                          appUpdate.openUpdateDialog();
                          setStatusPopoverOpen(false);
                        }}
                      >
                        <ArrowUpCircle
                          className={cn(
                            "h-4 w-4 shrink-0",
                            appUpdate.state.status === "readyToRestart" || appUpdate.state.status === "downloading"
                              ? "text-app-accent"
                              : "text-app-muted",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-app-text">
                            {appUpdate.state.status === "readyToRestart"
                              ? browserRuntime.isMobile
                                ? text("安装 APK", "Install APK")
                                : text("重启完成更新", "Restart to finish update")
                              : appUpdate.state.status === "downloading"
                                ? text("正在下载更新", "Downloading update")
                                : text(`更新到 ${appUpdate.state.info?.version ?? ""}`, `Update to ${appUpdate.state.info?.version ?? ""}`)}
                          </span>
                          <span className="block truncate text-xs text-app-muted">
                            {appUpdate.state.status === "downloading"
                              ? `${appUpdate.state.progress?.percent ?? 0}%`
                              : appUpdate.state.status === "readyToRestart"
                                 ? browserRuntime.isMobile
                                   ? text("APK 已就绪", "APK is ready")
                                   : text("重启客户端后生效", "Relaunch the app to apply the update")
                                 : text("有新版本可用", "A new version is available")}
                          </span>
                        </span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        {downloadQueueOpen ? (
          <div ref={downloadQueueRef} className="app-mobile-queue-panel fixed right-3 top-16 z-50 w-[calc(100vw-1.5rem)] max-w-xl origin-top-right rounded-lg border border-app-border bg-app-elevated shadow-popover app-pop-enter md:right-5" style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }} role="dialog" aria-label={text("下载队列", "Download queue")}>
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
                <button className="app-interactive flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text" type="button" onClick={() => setDownloadQueueOpen(false)}>
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
                      <div key={item.id} className="rounded-md bg-app-panel/60 p-3">
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
                              <Button aria-label={t("common.retry")} className="h-8 w-8 px-0" type="button" title={t("common.retry")} variant="ghost" onClick={() => downloadQueue.retry(item.id)}>
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            ) : null}
                            {browserRuntime.supportsFileReveal && item.status === "done" && item.destinationPath ? (
                              <>
                                <Button aria-label={text("打开所在文件夹", "Open containing folder")} className="h-8 w-8 px-0" type="button" title={text("打开所在文件夹", "Open containing folder")} variant="ghost" onClick={() => revealDownloadedPath(item.destinationPath!)}>
                                  <FolderOpen className="h-4 w-4" />
                                </Button>
                                <Button aria-label={text("打开文件", "Open file")} className="h-8 w-8 px-0" type="button" title={text("打开文件", "Open file")} variant="ghost" onClick={() => openDownloadedPath(item.destinationPath!)}>
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </>
                            ) : null}
                            {active ? (
                              <Button aria-label={text("取消下载", "Cancel download")} className="h-8 w-8 px-0" type="button" title={text("取消下载", "Cancel download")} variant="ghost" onClick={() => downloadQueue.cancel(item.id)}>
                                <X className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <ProgressBar className="mt-3" label={item.filename} value={item.status === "done" ? 100 : item.progress} />
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
          <div ref={commitQueueRef} className="app-mobile-queue-panel fixed right-3 top-16 z-50 w-[calc(100vw-1.5rem)] max-w-xl origin-top-right rounded-lg border border-app-border bg-app-elevated shadow-popover app-pop-enter md:right-5" style={{ top: "calc(3.5rem + env(safe-area-inset-top, 0px))" }} role="dialog" aria-label={text("提交队列", "Commit queue")}>
            <div className="flex h-12 items-center justify-between border-b border-app-border px-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-app-text">{text("提交队列", "Commit queue")}</div>
                <div className="text-xs text-app-muted">
                  {commitQueue.summary.total
                    ? text(
                        `${commitQueue.summary.completed}/${commitQueue.summary.total} 完成，${commitQueue.summary.failed} 失败`,
                        `${commitQueue.summary.completed}/${commitQueue.summary.total} done, ${commitQueue.summary.failed} failed`,
                      )
                    : text("暂无提交任务", "No commits")}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button className="h-8 px-2 text-xs" disabled={commitQueue.summary.completed === 0} type="button" variant="ghost" onClick={commitQueue.clearCompleted}>
                  {text("清理", "Clear")}
                </Button>
                <button className="app-interactive flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text" type="button" onClick={() => setCommitQueueOpen(false)}>
                  <X className="h-4 w-4" />
                  <span className="sr-only">{t("common.close")}</span>
                </button>
              </div>
            </div>
            <div className="max-h-[min(28rem,calc(100vh-8rem))] overflow-auto p-2">
              {commitQueue.items.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-app-muted">{text("提交任务会显示在这里", "Commits will appear here")}</div>
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
                      <div key={item.id} className="rounded-md bg-app-panel/60 p-3">
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
        {isOnline ? null : (
          <div className="flex items-center gap-2 bg-app-warningSoft px-4 py-1.5 text-sm font-medium text-app-warningText" role="alert">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span>{text("网络已断开，部分功能可能不可用", "You are offline. Network features are unavailable.")}</span>
          </div>
        )}
        {transportBlocked ? (
          <div className="flex items-center gap-2 bg-app-dangerSoft px-4 py-1.5 text-sm font-medium text-app-danger" role="alert">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span>{t("shell.transportBlocked")}</span>
            <Button className="ml-auto h-7 px-2" type="button" variant="secondary" onClick={() => navigate("/settings")}>
              {t("nav.settings")}
            </Button>
          </div>
        ) : null}
        <main id="main-content" className="app-main-content min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain px-3 py-4 pb-32 sm:p-5 sm:pb-32 md:px-6 md:pb-6" onScroll={handleMainScroll}>
          <div key={location.pathname} className="app-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      {moreMenuOpen ? (
        <>
        {/* Dims the page above the sheet; the existing outside-press handler closes on tap. */}
        <div
          ref={moreScrimRef}
          aria-hidden="true"
          className="app-scrim fixed inset-x-0 top-0 z-[45] md:hidden"
          style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}
        />
        <div
          ref={moreMenuRef}
          className="app-mobile-action-sheet app-surface-enter fixed inset-x-0 z-50 rounded-t-lg border-t border-app-border bg-app-elevated shadow-popover md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={text("更多页面", "More pages")}
          style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="grid grid-cols-3 gap-1 p-2">
            {secondaryMobileNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "app-interactive flex flex-col items-center justify-center gap-1.5 rounded-md py-3 text-xs",
                    isActive ? "bg-app-accentSoft font-medium text-app-accent" : "text-app-muted hover:bg-app-panel hover:text-app-text",
                  )
                }
                onClick={() => setMoreMenuOpen(false)}
              >
                <item.icon className="h-5 w-5" />
                <span>{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </div>
          <div className="space-y-3 border-t border-app-border px-3 pb-3 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ThemeSwitch />
              <LanguageSwitch compact />
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-accentSoft text-sm font-semibold text-app-accent" aria-hidden="true">
                {userInitial}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-app-text">{userName}</span>
              <Button className="h-9 shrink-0" type="button" variant="secondary" onClick={onLogoutClick}>
                <LogOut className="h-4 w-4" />
                {t("shell.logout")}
              </Button>
            </div>
          </div>
        </div>
        </>
      ) : null}
      <nav
        ref={mobileNavRef}
        aria-label={text("主导航", "Main navigation")}
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-app-border bg-app-surface md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <span ref={mobileIndicatorRef} aria-hidden="true" className="app-sliding-indicator rounded-full bg-app-accentSoft" />
        {primaryMobileNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] transition-colors duration-[var(--app-motion-fast)]",
                isActive ? "font-medium text-app-text" : "text-app-muted",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className="app-nav-pill relative flex h-7 w-14 items-center justify-center rounded-full">
                  <item.icon className={cn("h-5 w-5", isActive && "text-app-accent")} />
                  {item.to === "/tasks" && unseenFailureCount > 0 ? (
                    <span className="app-numeric absolute -top-1 right-2 min-w-4 rounded-full bg-app-danger px-1 text-center text-[0.6875rem] font-semibold leading-4 text-app-onAccent">
                      {unseenFailureCount}
                      <span className="sr-only">{unseenFailureLabel}</span>
                    </span>
                  ) : null}
                </span>
                <span>{t(item.labelKey)}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          ref={moreButtonRef}
          type="button"
          aria-expanded={moreMenuOpen}
          aria-haspopup="dialog"
          data-active={secondaryRouteActive ? "true" : undefined}
          className={cn(
            "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] transition-colors duration-[var(--app-motion-fast)]",
            secondaryRouteActive || moreMenuOpen ? "font-medium text-app-text" : "text-app-muted",
          )}
          onClick={() => setMoreMenuOpen((v) => !v)}
        >
          <span className="app-nav-pill relative flex h-7 w-14 items-center justify-center rounded-full">
            <MoreHorizontal className={cn("h-5 w-5", secondaryRouteActive && "text-app-accent")} />
          </span>
          <span>{text("更多", "More")}</span>
        </button>
      </nav>
    </div>
  );
}
