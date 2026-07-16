import { AlertCircle, Check, Circle, ExternalLink, Maximize2, Minimize2, Plus, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { browserRuntime } from "../../lib/runtime";
import { useI18n } from "../../lib/i18n";
import { useConfirmAction } from "../../lib/use-confirm-action";
import type { SshConnectionRequest } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, Input } from "../ui";
import { SshTerminalTab } from "./SshTerminalTab";

type AppSshTerminalDialogProps = {
  request: SshConnectionRequest | null;
  onClose: () => void;
};

type TabState = {
  id: string;
  request: SshConnectionRequest;
  status: string;
};

type TabStatusKind = "ready" | "connected" | "failed" | "closed" | "other";

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

function sameTarget(a: SshConnectionRequest, b: SshConnectionRequest) {
  return a.host === b.host && a.port === b.port && a.username === b.username && a.taskId === b.taskId;
}

// Derive a stable status kind from the status string for icon/color/aria.
// Check "closed" before "connected" since "Disconnected" contains "connected".
function deriveStatusKind(status: string): TabStatusKind {
  if (status.includes("已关闭") || /\b(closed|disconnected)\b/i.test(status)) return "closed";
  if (status.includes("已连接") || /\bconnected\b/i.test(status)) return "connected";
  if (status.includes("失败") || /\bfailed\b/i.test(status)) return "failed";
  if (status.includes("准备连接") || /\bready\b/i.test(status)) return "ready";
  return "other";
}

function isLiveStatus(status: string): boolean {
  return deriveStatusKind(status) === "connected";
}

export function AppSshTerminalDialog({ request, onClose }: AppSshTerminalDialogProps) {
  const { t, text } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const newTabFormRef = useRef<HTMLFormElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const confirmAction = useConfirmAction();
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showNewTabForm, setShowNewTabForm] = useState(false);
  const [newHost, setNewHost] = useState("");
  const [newPort, setNewPort] = useState("22");
  const [newUsername, setNewUsername] = useState("");
  const [dialogSize, setDialogSize] = useState<{ width: number; height: number } | null>(null);
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

  const openTab = useCallback((tabRequest: SshConnectionRequest) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}`;
    setTabs((prev) => [...prev, { id, request: tabRequest, status: text("准备连接", "Ready to connect") }]);
    setActiveTabId(id);
    setShowNewTabForm(false);
  }, [text]);

  // Initialize / sync the first tab from the incoming request prop.
  useEffect(() => {
    if (!request) return;
    setTabs((prev) => {
      if (prev.length === 0) {
        const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}`;
        setActiveTabId(id);
        return [{ id, request, status: text("准备连接", "Ready to connect") }];
      }
      // If the incoming request targets a different host than the active tab, open a new tab.
      const active = prev.find((tab) => tab.id === activeTabId);
      if (active && sameTarget(active.request, request)) return prev;
      const exists = prev.find((tab) => sameTarget(tab.request, request));
      if (exists) {
        setActiveTabId(exists.id);
        return prev;
      }
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}`;
      setActiveTabId(id);
      return [...prev, { id, request, status: text("准备连接", "Ready to connect") }];
    });
    setIsMinimized(false);
  }, [request, text, activeTabId]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        setActiveTabId(null);
        onClose();
        return next;
      }
      if (id === activeTabId) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTabId(fallback.id);
      }
      return next;
    });
  }, [activeTabId, onClose]);

  // Wrap closeTab with a confirmation guard for live (connected) sessions.
  const requestCloseTab = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (isLiveStatus(tab.status)) {
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
    void browserRuntime
      .openSshWindow(active.request)
      .then(() => closeTab(active.id))
      .catch(() => {});
  }, [tabs, activeTabId, closeTab]);

  // Wrap dialog close with a confirmation guard when live sessions exist.
  const requestCloseDialog = useCallback(() => {
    const liveCount = tabs.filter((t) => isLiveStatus(t.status)).length;
    if (liveCount > 0) {
      confirmAction.confirm({
        title: text("关闭终端窗口", "Close terminal window"),
        description: text(
          `还有 ${liveCount} 个活动 SSH 连接，关闭将终止所有会话。确定关闭吗？`,
          `${liveCount} active SSH connection${liveCount > 1 ? "s" : ""} will be terminated. Close anyway?`,
        ),
        confirmLabel: text("关闭", "Close"),
        tone: "danger",
        run: () => {
          setTabs([]);
          setActiveTabId(null);
          onClose();
        },
      });
    } else {
      setTabs([]);
      setActiveTabId(null);
      onClose();
    }
  }, [tabs, text, confirmAction, onClose]);

  const updateTabStatus = useCallback((id: string, status: string) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, status } : tab)));
  }, []);

  const focusTab = useCallback((id: string) => {
    tabRefs.current.get(id)?.focus();
  }, []);

  const previousFocusRef = useRef<HTMLElement | null>(null);
  const hasFocusedRef = useRef(false);

  // 首次打开时将焦点移入对话框，符合 WAI-ARIA dialog 模式。
  useEffect(() => {
    if (!request) {
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
  }, [request]);

  // 对话框卸载时恢复焦点到触发元素。
  useEffect(() => {
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, currentIdx: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveTabId(tabs[currentIdx].id);
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
    const username = newUsername.trim();
    const port = newPort.trim() || "22";
    const newRequest: SshConnectionRequest = {
      host,
      port,
      username: username || undefined,
      command: `ssh ${username ? `${username}@` : ""}${host}${port && port !== "22" ? `:${port}` : ""}`,
      authMode: "password",
    };
    openTab(newRequest);
    setNewHost("");
    setNewPort("22");
    setNewUsername("");
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      const activeElement = document.activeElement;
      // If the new-tab form is open and focus is inside it, Escape closes just the form
      // (not the entire dialog, which may hold live SSH sessions).
      if (showNewTabForm && newTabFormRef.current?.contains(activeElement)) {
        event.preventDefault();
        setShowNewTabForm(false);
        return;
      }
      const isTerminalFocused = activeElement?.closest(".xterm") ?? false;
      if (!isTerminalFocused || event.ctrlKey) {
        event.preventDefault();
        requestCloseDialog();
      }
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
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

  if (!request && tabs.length === 0) return null;

  return createPortal(
    <>
      <div
        ref={dialogRef}
        className={cn(
          "app-modal-overlay fixed inset-0 z-50 items-start justify-center px-3 py-4 sm:px-4 sm:py-10",
          isMinimized ? "hidden" : "flex",
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <div
          className={cn(
            "app-terminal-modal-panel relative flex flex-col overflow-hidden rounded-lg bg-app-terminalBg",
            dialogSize ? "" : "max-h-[calc(100vh-5rem)] w-full max-w-5xl",
          )}
          style={dialogSize ?? undefined}
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
              {browserRuntime.supportsInAppSsh ? (
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-1 disabled:opacity-40"
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
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-1"
                type="button"
                title={text("最小化", "Minimize")}
                aria-label={text("最小化", "Minimize")}
                onClick={() => setIsMinimized(true)}
              >
                <Minimize2 className="h-4 w-4" />
                <span className="sr-only">{text("最小化", "Minimize")}</span>
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-1"
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
            className="flex h-9 shrink-0 items-center border-b border-app-terminalBorder bg-app-terminalPanel"
            role="tablist"
            aria-label={text("SSH 会话标签", "SSH session tabs")}
          >
            <div className="flex h-9 flex-1 items-center gap-1 overflow-x-auto px-2">
              {tabs.map((tab, idx) => {
                const kind = deriveStatusKind(tab.status);
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    id={`ssh-tab-${tab.id}`}
                    ref={(el) => {
                      if (el) tabRefs.current.set(tab.id, el);
                      else tabRefs.current.delete(tab.id);
                    }}
                    className={cn(
                      "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-1",
                      isActive
                        ? "bg-app-terminalBg text-app-terminalText"
                        : kind === "failed"
                          ? "text-app-danger hover:bg-app-terminalBg/60 hover:text-app-terminalText"
                          : kind === "closed"
                            ? "text-app-warning hover:bg-app-terminalBg/60 hover:text-app-terminalText"
                            : "text-app-terminalMuted hover:bg-app-terminalBg/60 hover:text-app-terminalText",
                    )}
                    role="tab"
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isActive}
                    aria-label={`${tabTitle(tab.request)}，${tab.status}`}
                    onClick={() => setActiveTabId(tab.id)}
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
                    <span className="max-w-[10rem] truncate">{tabTitle(tab.request)}</span>
                    <button
                      className="flex h-4 w-4 items-center justify-center rounded text-app-terminalMuted hover:bg-app-terminalPanel hover:text-app-terminalText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                      type="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
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
            <div className="flex h-9 shrink-0 items-center px-2">
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-app-terminalMuted hover:bg-app-terminalBg hover:text-app-terminalText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent focus-visible:ring-offset-1"
                type="button"
                title={t("terminal.newTab")}
                aria-label={t("terminal.newTab")}
                onClick={() => setShowNewTabForm((prev) => !prev)}
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
            role="tabpanel"
            aria-labelledby={activeTabId ? `ssh-tab-${activeTabId}` : undefined}
          >
            {tabs.map((tab) => (
              <SshTerminalTab
                key={tab.id}
                request={tab.request}
                tabId={tab.id}
                active={tab.id === activeTabId}
                onStatusChange={(status) => updateTabStatus(tab.id, status)}
              />
            ))}
          </div>

          {/* Resize handle (bottom-right corner drag) */}
          <div
            className="absolute bottom-0 right-0 z-10 flex h-4 w-4 cursor-nwse-resize items-end justify-end"
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
          className="fixed right-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-app-terminalBg px-4 py-3 text-left text-app-terminalText shadow-popover hover:bg-app-terminalPanel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
          aria-label={text(`恢复应用内 SSH ${tabTitle(activeTab.request)}`, `Restore in-app SSH ${tabTitle(activeTab.request)}`)}
          type="button"
          onClick={() => setIsMinimized(false)}
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
          {tabs.some((tab) => tab.id !== activeTab.id && (deriveStatusKind(tab.status) === "failed" || deriveStatusKind(tab.status) === "closed")) ? (
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
