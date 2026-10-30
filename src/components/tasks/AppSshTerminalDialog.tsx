import { AlertCircle, Check, Circle, ExternalLink, Maximize2, Minimize2, Plus, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { getRuntimeSettings, type SshTerminalPreferences } from "../../lib/app-settings";
import { browserRuntime } from "../../lib/runtime";
import { useI18n } from "../../lib/i18n";
import { findSshConnectionIssue, formatSshCommand, resolveSshConnectionRequest } from "../../lib/ssh-info";
import { useConfirmAction } from "../../lib/use-confirm-action";
import { useToast } from "../../lib/use-toast";
import { useMobileBackLayer } from "../../lib/use-mobile-back-stack";
import { claimOverlayKey, useOverlay } from "../../lib/overlay-stack";
import type { SshAuthMode, SshConnectionRequest } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, Input, Select } from "../ui";
import { SshTerminalTab } from "./SshTerminalTab";
import { useSshWorkspace } from "../../lib/use-ssh-workspace";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function tabTitle(request: SshConnectionRequest) {
  return request.taskName || request.host || "SSH";
}

/**
 * The singleton viewport of the global in-app SSH workspace (SSH-P2-11). Tab
 * state lives in `useSshWorkspaceStore` far above any route, so this dialog
 * survives route changes: it renders nothing while the workspace is empty and
 * is mounted once by `SshWorkspaceGate` at the app root.
 */
export function AppSshTerminalDialog() {
  const workspace = useSshWorkspace();
  const tabs = workspace.tabs;
  const activeTabId = workspace.activeTabId;
  const isMinimized = workspace.isMinimized;
  const hasTabs = tabs.length > 0;
  const { t, text } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const newTabFormRef = useRef<HTMLFormElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const confirmAction = useConfirmAction();
  const toast = useToast();
  // A modal while visible; menus inside it (the terminal tool menu) sit above it in the stack.
  const layerRef = useOverlay(hasTabs && !isMinimized, "modal");
  const [showNewTabForm, setShowNewTabForm] = useState(false);
  const [newHost, setNewHost] = useState("");
  // Defaults come from SSH settings so every entry resolves the same target;
  // the resolver re-reads settings on submit for changes made mid-session.
  const [newPort, setNewPort] = useState(() => String(getRuntimeSettings().ssh.defaultPort));
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newAuthMode, setNewAuthMode] = useState<SshAuthMode>(() => getRuntimeSettings().ssh.authMode);
  const [newKeyPath, setNewKeyPath] = useState(() => getRuntimeSettings().ssh.sshKeyPath);
  const [dialogSize, setDialogSize] = useState<{ width: number; height: number } | null>(null);
  const [mobileViewportHeight, setMobileViewportHeight] = useState<number | null>(() =>
    browserRuntime.isMobile ? window.visualViewport?.height ?? window.innerHeight : null,
  );
  const resizeStateRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  const startResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = dialogRef.current?.querySelector<HTMLElement>(".app-terminal-modal-panel");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startW: rect.width,
      startH: rect.height,
    };
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const rs = resizeStateRef.current;
      if (!rs) return;
      const dx = event.clientX - rs.startX;
      const dy = event.clientY - rs.startY;
      const maxWidth = window.innerWidth - 32;
      const maxHeight = window.innerHeight - 32;
      const width = Math.min(Math.max(rs.startW + dx, 480), maxWidth);
      const height = Math.min(Math.max(rs.startH + dy, 320), maxHeight);
      setDialogSize({ width, height });
    };
    const onMouseUp = () => {
      if (!resizeStateRef.current) return;
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Trigger terminal fit after resize ends.
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Closing a tab moves focus to the neighbor the store activates; the store
  // owns the tab array, the dialog only owns focus restoration.
  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((tab) => tab.id === id);
      if (idx === -1) return;
      const remaining = tabs.filter((tab) => tab.id !== id);
      workspace.closeTab(id);
      if (remaining.length === 0) return;
      const fallback =
        id === activeTabId
          ? remaining[Math.min(idx, remaining.length - 1)]
          : (remaining.find((tab) => tab.id === activeTabId) ?? remaining[0]);
      window.setTimeout(() => tabRefs.current.get(fallback.id)?.focus(), 0);
    },
    [tabs, activeTabId, workspace],
  );

  // Wrap closeTab with a confirmation guard for live (connected) sessions.
  const requestCloseTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "connected") {
      confirmAction.confirm({
        title: text("关闭已连接的标签", "Close connected tab"),
        description: text(
          `${tabTitle(tab.request)} 仍有活动 SSH 连接，关闭将终止会话并丢弃滚动历史。确定关闭吗？`,
          `${tabTitle(tab.request)} still has an active SSH connection. Closing will terminate the session and discard scrollback. Close anyway?`,
        ),
        confirmLabel: text("关闭", "Close"),
        tone: "danger",
        run: () => closeTab(id),
      });
    } else {
      closeTab(id);
    }
  }, [tabs, text, confirmAction, closeTab]);

  // Pop the active tab out to a standalone window. The new window establishes
  // its own SSH session; the original tab is closed to avoid duplicates.
  const handlePopOut = useCallback(() => {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active) return;
    const { ssh } = getRuntimeSettings();
    const preferences: SshTerminalPreferences = {
      portForwards: ssh.portForwards,
      maxHistoryEntries: ssh.maxHistoryEntries,
      terminal: ssh.terminal,
    };
    void browserRuntime
      .openSshWindow(resolveSshConnectionRequest(active.request), preferences)
      .then(() => closeTab(active.id))
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : text("无法弹出独立窗口", "Unable to pop out to a standalone window");
        toast.error(text("弹出窗口失败", "Failed to pop out window"), message);
      });
  }, [tabs, activeTabId, closeTab, text, toast]);

  // Wrap workspace close with a confirmation guard when live sessions exist.
  const requestCloseDialog = useCallback(() => {
    const liveCount = tabs.filter((t) => t.kind === "connected").length;
    if (liveCount > 0) {
      confirmAction.confirm({
        title: text("关闭终端窗口", "Close terminal window"),
        description: text(
          `还有 ${liveCount} 个活动 SSH 连接，关闭将终止所有会话。确定关闭吗？`,
          `${liveCount} active SSH connection${liveCount > 1 ? "s" : ""} will be terminated. Close anyway?`,
        ),
        confirmLabel: text("关闭", "Close"),
        tone: "danger",
        run: () => workspace.closeAllTabs(),
      });
    } else {
      workspace.closeAllTabs();
    }
  }, [tabs, text, confirmAction, workspace]);

  useMobileBackLayer(hasTabs && !isMinimized, requestCloseDialog);

  useEffect(() => {
    if (!browserRuntime.isMobile || !hasTabs) return undefined;
    const viewport = window.visualViewport;
    const updateHeight = () => {
      setMobileViewportHeight(viewport?.height ?? window.innerHeight);
    };
    const updateTerminal = () => {
      updateHeight();
      window.dispatchEvent(new Event("resize"));
    };
    updateHeight();
    viewport?.addEventListener("resize", updateTerminal);
    viewport?.addEventListener("scroll", updateTerminal);
    window.addEventListener("resize", updateHeight);
    return () => {
      viewport?.removeEventListener("resize", updateTerminal);
      viewport?.removeEventListener("scroll", updateTerminal);
      window.removeEventListener("resize", updateHeight);
    };
  }, [hasTabs]);

  const focusTab = useCallback((id: string) => {
    tabRefs.current.get(id)?.focus();
  }, []);

  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasFocusedRef = useRef(false);

  // 首次打开时将焦点移入对话框，符合 WAI-ARIA dialog 模式。
  useEffect(() => {
    if (!hasTabs) {
      hasFocusedRef.current = false;
      return;
    }
    if (hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        dialogRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hasTabs]);

  // 对话框卸载时恢复焦点到触发元素。
  useEffect(() => {
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      workspace.setActiveTabId(tabs[currentIdx].id);
      return;
    }

    let nextIdx: number | null = null;
    if (event.key === "ArrowRight") nextIdx = currentIdx + 1 < tabs.length ? currentIdx + 1 : 0;
    else if (event.key === "ArrowLeft") nextIdx = currentIdx - 1 >= 0 ? currentIdx - 1 : tabs.length - 1;
    else if (event.key === "Home") nextIdx = 0;
    else if (event.key === "End") nextIdx = tabs.length - 1;

    if (nextIdx !== null) {
      event.preventDefault();
      focusTab(tabs[nextIdx].id);
    }
  };

  const handleNewTabSubmit = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const host = newHost.trim();
    if (!host) return;
    // Auth mode is the user's choice. In password mode an empty field falls
    // back to the configured default password so platform instances do not
    // need it retyped; in key mode the field is a passphrase and must never
    // inherit the account password.
    const enteredPassword = newPassword.trim() ? newPassword : undefined;
    const password = newAuthMode === "key"
      ? enteredPassword
      : enteredPassword ?? (getRuntimeSettings().ssh.defaultPassword || undefined);
    const request = resolveSshConnectionRequest({
      host,
      port: newPort.trim() || undefined,
      username: newUsername.trim() || undefined,
      password,
      command: "",
      authMode: newAuthMode,
      sshKeyPath: newKeyPath.trim() || undefined,
    });
    const issue = findSshConnectionIssue(request);
    if (issue) {
      toast.error(text("无法连接", "Cannot connect"), issue);
      return;
    }
    // The command is display/copy text; only spell out a non-default port.
    const defaultPort = String(getRuntimeSettings().ssh.defaultPort);
    const resolvedPort = request.port ?? defaultPort;
    // Same formatter as every other entry: bare args (validation already ran
    // above), `-p` only when the port differs from the settings default.
    const command = formatSshCommand({
      host: request.host,
      port: resolvedPort !== defaultPort ? resolvedPort : undefined,
      username: request.username,
    });
    if (!command) return;
    request.command = command;
    workspace.openTab(request);
    setShowNewTabForm(false);
    setNewHost("");
    setNewPort(defaultPort);
    setNewUsername("");
    setNewPassword("");
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Mid-composition Escape belongs to the IME; host-key (and similar) alertdialogs handle Escape themselves.
      if (event.nativeEvent.isComposing) return;
      if (event.target instanceof Element && event.target.closest('[role="alertdialog"]')) {
        return;
      }
      const activeElement = document.activeElement;
      // If the new-tab form is open and focus is inside it, Escape closes just the form
      // (not the entire dialog, which may hold live SSH sessions).
      if (showNewTabForm && newTabFormRef.current?.contains(activeElement)) {
        event.preventDefault();
        setShowNewTabForm(false);
        return;
      }
      const isTerminalFocused = activeElement?.closest(".xterm") ?? false;
      if ((!isTerminalFocused || event.ctrlKey) && claimOverlayKey(layerRef.current, event.nativeEvent)) {
        event.preventDefault();
        requestCloseDialog();
      }
      return;
    }

    if (event.key !== "Tab") return;

    // When a nested alertdialog (e.g. host-key confirm) is open, trap Tab there only.
    const nestedAlert = dialogRef.current?.querySelector<HTMLElement>('[role="alertdialog"]');
    const trapRoot = nestedAlert ?? dialogRef.current;
    const focusable = Array.from(trapRoot?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
      (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!hasTabs) return null;

  return createPortal(
    <>
      <div
        ref={dialogRef}
        className={cn(
          "app-modal-overlay app-ssh-terminal-overlay fixed inset-0 z-50 items-start justify-center px-3 py-4 sm:px-4 sm:py-10",
          isMinimized ? "hidden" : "flex",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <div
          className={cn(
            "app-terminal-modal-panel app-ssh-terminal-panel app-terminal-chrome relative flex flex-col overflow-hidden rounded-lg bg-app-terminalBg",
            dialogSize ? "shadow-popover" : "max-h-[calc(100vh-5rem)] w-full max-w-5xl",
          )}
          style={browserRuntime.isMobile ? { height: mobileViewportHeight ? `${mobileViewportHeight}px` : "100dvh", width: "100%" } : dialogSize ?? undefined}
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-app-terminalBorder bg-app-terminalPanel px-4">
            <div className="flex min-w-0 items-center gap-2 text-app-terminalText">
              <Terminal className="h-4 w-4 shrink-0 text-app-terminalAccent" />
              <h2 id={titleId} className="truncate text-sm font-semibold">
                {text("应用内 SSH", "In-app SSH")}
                {activeTab ? ` · ${tabTitle(activeTab.request)}` : ""}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              {browserRuntime.supportsSshPopOut ? (
                <button
                  className="app-ssh-desktop-control flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText disabled:opacity-40"
                  type="button"
                  title={text("弹出为独立窗口", "Pop out to standalone window")}
                  aria-label={text("弹出为独立窗口", "Pop out to standalone window")}
                  onClick={handlePopOut}
                  disabled={!activeTab}
                >
                  <ExternalLink className="h-4 w-4" />
                  <span className="sr-only">{text("弹出为独立窗口", "Pop out to standalone window")}</span>
                </button>
              ) : null}
              <button
                className="app-ssh-desktop-control flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText"
                type="button"
                title={text("最小化", "Minimize")}
                aria-label={text("最小化", "Minimize")}
                onClick={() => workspace.setMinimized(true)}
              >
                <Minimize2 className="h-4 w-4" />
                <span className="sr-only">{text("最小化", "Minimize")}</span>
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText"
                type="button"
                title={text("关闭", "Close")}
                aria-label={text("关闭", "Close")}
                onClick={requestCloseDialog}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{text("关闭", "Close")}</span>
              </button>
            </div>
          </div>

          <div
            className="flex h-12 shrink-0 items-center border-b border-app-terminalBorder bg-app-terminalPanel md:h-9"
            role="tablist"
            aria-label={text("SSH 会话标签", "SSH session tabs")}
          >
            <div className="flex h-12 flex-1 items-center gap-1 overflow-x-auto px-2 md:h-9">
              {tabs.map((tab, idx) => {
                const kind = tab.kind;
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      "group flex h-11 shrink-0 items-center rounded-md text-xs md:h-7",
                      isActive
                        ? "bg-app-terminalBg text-app-terminalText"
                        : kind === "failed"
                          ? "text-app-danger hover:bg-app-terminalBg/60 hover:text-app-terminalText"
                          : kind === "closed"
                            ? "text-app-warning hover:bg-app-terminalBg/60 hover:text-app-terminalText"
                            : "text-app-terminalMuted hover:bg-app-terminalBg/60 hover:text-app-terminalText",
                    )}
                  >
                    <button
                      id={`ssh-tab-${tab.id}`}
                      ref={(element) => {
                        if (element) tabRefs.current.set(tab.id, element);
                        else tabRefs.current.delete(tab.id);
                      }}
                      className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md px-2.5 text-left focus-visible:-outline-offset-2"
                      type="button"
                      role="tab"
                      tabIndex={isActive ? 0 : -1}
                      aria-selected={isActive}
                      aria-controls={`ssh-terminal-panel-${tab.id}`}
                      aria-label={`${tabTitle(tab.request)}，${tab.status}`}
                      onClick={() => {
                        workspace.setActiveTabId(tab.id);
                      }}
                      onKeyDown={(event) => handleTabKeyDown(event, idx)}
                      title={tab.request.command}
                    >
                      {kind === "connected" ? (
                        <Check className="h-3 w-3 shrink-0 text-app-success" aria-hidden="true" />
                      ) : kind === "failed" ? (
                        <AlertCircle className="h-3 w-3 shrink-0 text-app-danger" aria-hidden="true" />
                      ) : (
                        <Circle className="h-3 w-3 shrink-0 text-app-terminalMuted" aria-hidden="true" />
                      )}
                      <span className="max-w-[8rem] truncate md:max-w-[10rem]">{tabTitle(tab.request)}</span>
                    </button>
                    <button
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-r-md text-app-terminalMuted hover:bg-app-terminalPanel hover:text-app-terminalText focus-visible:-outline-offset-2 md:h-6 md:w-6"
                      type="button"
                      onClick={() => {
                        requestCloseTab(tab.id);
                      }}
                      aria-label={text(`关闭 ${tabTitle(tab.request)} 标签`, `Close ${tabTitle(tab.request)} tab`)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex h-12 shrink-0 items-center px-2 md:h-9">
              <button
                className="flex h-11 w-11 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText md:h-7 md:w-7"
                type="button"
                title={t("terminal.newTab")}
                aria-label={t("terminal.newTab")}
                aria-expanded={showNewTabForm}
                onClick={() => {
                  // Drop a typed-but-not-submitted password when the form is
                  // dismissed; host/port/username may stay for convenience.
                  if (showNewTabForm) setNewPassword("");
                  setShowNewTabForm((prev) => !prev);
                }}
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {showNewTabForm ? (
            <form
              ref={newTabFormRef}
              className="flex h-auto shrink-0 flex-wrap items-center gap-2 border-b border-app-terminalBorder bg-app-terminalPanel px-3 py-2"
              onSubmit={handleNewTabSubmit}
            >
              <Input
                className="h-8 w-40 border-app-terminalBorder bg-app-terminalBg text-app-terminalText placeholder:text-app-terminalMuted"
                placeholder={t("terminal.host")}
                aria-label={t("terminal.host")}
                value={newHost}
                onChange={(event) => setNewHost(event.target.value)}
                autoFocus
              />
              <Input
                className="h-8 w-20 border-app-terminalBorder bg-app-terminalBg text-app-terminalText placeholder:text-app-terminalMuted"
                placeholder={t("terminal.port")}
                aria-label={t("terminal.port")}
                value={newPort}
                onChange={(event) => setNewPort(event.target.value)}
              />
              <Input
                className="h-8 w-32 border-app-terminalBorder bg-app-terminalBg text-app-terminalText placeholder:text-app-terminalMuted"
                placeholder={t("terminal.username")}
                aria-label={t("terminal.username")}
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
              />
              <Select
                className="h-8 border-app-terminalBorder bg-app-terminalBg text-app-terminalText"
                aria-label={text("认证方式", "Authentication")}
                value={newAuthMode}
                onChange={(event) => setNewAuthMode(event.target.value === "key" ? "key" : "password")}
              >
                <option value="password">{text("密码", "Password")}</option>
                <option value="key">{text("私钥", "Private key")}</option>
              </Select>
              {newAuthMode === "key" ? (
                <Input
                  className="h-8 w-48 border-app-terminalBorder bg-app-terminalBg text-app-terminalText placeholder:text-app-terminalMuted"
                  placeholder={text("私钥路径（可选）", "Key path (optional)")}
                  aria-label={text("私钥路径", "Key path")}
                  value={newKeyPath}
                  onChange={(event) => setNewKeyPath(event.target.value)}
                />
              ) : null}
              <Input
                className="h-8 w-32 border-app-terminalBorder bg-app-terminalBg text-app-terminalText placeholder:text-app-terminalMuted"
                type="password"
                autoComplete="off"
                placeholder={newAuthMode === "key" ? text("私钥口令（可选）", "Key passphrase (optional)") : t("terminal.password")}
                aria-label={newAuthMode === "key" ? text("私钥口令", "Key passphrase") : t("terminal.password")}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <Button type="submit" className="h-8" disabled={!newHost.trim()}>
                {t("terminal.connect")}
              </Button>
            </form>
          ) : null}

          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              dialogSize ? "" : "h-[min(80vh,780px)]",
            )}
          >
            {tabs.map((tab) => (
              <SshTerminalTab
                key={tab.id}
                request={tab.request}
                tabId={tab.id}
                active={tab.id === activeTabId}
                onStatusChange={(status, kind) => workspace.updateTabStatus(tab.id, status, kind)}
              />
            ))}
          </div>

          {/* Resize handle (bottom-right corner drag). The handle sits above
              the xterm canvas/textarea (which would otherwise swallow the
              mousedown), and is sized larger than its visible grip so the
              hit target is comfortable while keeping the visual subtle. */}
          <div
            className="app-ssh-terminal-resize-handle absolute bottom-0 right-0 z-50 flex h-5 w-5 cursor-nwse-resize items-end justify-end"
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label={text("拖拽调整大小", "Drag to resize")}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-app-terminalMuted">
              <path d="M7 1L1 7M7 4L4 7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>

      {isMinimized && activeTab ? (
        <button
          className="app-terminal-chrome fixed right-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-app-terminalBg px-4 py-3 text-left text-app-terminalText shadow-popover hover:bg-app-terminalPanel"
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
          aria-label={text(`恢复应用内 SSH ${tabTitle(activeTab.request)}`, `Restore in-app SSH ${tabTitle(activeTab.request)}`)}
          type="button"
          onClick={() => workspace.setMinimized(false)}
        >
          <Terminal className="h-4 w-4 shrink-0 text-app-terminalAccent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{tabTitle(activeTab.request)}</span>
            <span className="mt-1 block truncate text-xs text-app-terminalMuted">{activeTab.status}</span>
          </span>
          {tabs.length > 1 ? (
            <span className="shrink-0 rounded-full bg-app-terminalPanel px-2 py-0.5 text-xs text-app-terminalMuted">
              {text(`${tabs.length} 个会话`, `${tabs.length} sessions`)}
            </span>
          ) : null}
          {tabs.some((tab) => tab.id !== activeTab.id && (tab.kind === "failed" || tab.kind === "closed")) ? (
            <span
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-app-danger"
              aria-label={text("有会话需要关注", "A session needs attention")}
            />
          ) : null}
          <Maximize2 className="h-4 w-4 shrink-0 text-app-terminalMuted" />
        </button>
      ) : null}
      {confirmAction.confirmDialog}
    </>,
    document.body,
  );
}
