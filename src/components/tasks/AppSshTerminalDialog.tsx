import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { Maximize2, Minimize2, RefreshCw, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { browserRuntime } from "../../lib/runtime";
import { useI18n } from "../../lib/i18n";
import type { SshConnectionRequest } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui";

type AppSshTerminalDialogProps = {
  request: SshConnectionRequest | null;
  onClose: () => void;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function AppSshTerminalDialog({ request, onClose }: AppSshTerminalDialogProps) {
  const { text } = useI18n();
  const titleId = useId();
  const statusId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isMinimizedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [status, setStatus] = useState(() => text("准备连接", "Ready to connect"));
  const [ctrlActive, setCtrlActive] = useState(false);
  const [canReconnect, setCanReconnect] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const ctrlActiveRef = useRef(false);
  const termRef = useRef<XTermInstance | null>(null);

  useEffect(() => {
    isMinimizedRef.current = isMinimized;
  }, [isMinimized]);

  useEffect(() => {
    setIsMinimized(false);
    setStatus(text("准备连接", "Ready to connect"));
    setCanReconnect(false);
  }, [request, text]);

  useEffect(() => {
    if (!request || !containerRef.current) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let terminal: XTermInstance | null = null;
    let fitAddon: FitAddonInstance | null = null;
    let dataDisposable: IDisposable | null = null;

    const resizeRemote = () => {
      if (!terminal || !fitAddon || isMinimizedRef.current) return;
      fitAddon.fit();
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      void browserRuntime.resizeSshSession(sessionId, terminal.cols, terminal.rows);
    };

    window.addEventListener("resize", resizeRemote);

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !containerRef.current) return;

      terminal = new XTerm({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'Consolas, "SFMono-Regular", "Cascadia Mono", monospace',
        fontSize: browserRuntime.isMobile ? 15 : 13,
        scrollback: 10_000,
        theme: {
          background: "oklch(0.18 0.028 255)",
          foreground: "oklch(0.9 0.018 255)",
          cursor: "oklch(0.78 0.12 235)",
        },
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, fallback to canvas renderer
      }
      try {
        const { WebLinksAddon } = await import("@xterm/addon-web-links");
        terminal.loadAddon(new WebLinksAddon());
      } catch {
        // WebLinks addon not available
      }
      termRef.current = terminal;
      terminal.onKey(({ domEvent: ev }) => {
        if (!ctrlActiveRef.current) return true;
        const key = ev.key;
        if (key.length === 1 && /[a-zA-Z]/.test(key) && !ev.altKey && !ev.metaKey) {
          const code = key.toLowerCase().charCodeAt(0) - 96;
          const sid = sessionIdRef.current;
          if (sid) void browserRuntime.writeSshSession(sid, String.fromCharCode(code));
          ctrlActiveRef.current = false;
          setCtrlActive(false);
          return false;
        }
        ctrlActiveRef.current = false;
        setCtrlActive(false);
        return true;
      });
      terminal.focus();
      terminal.writeln(text("正在建立 SSH 连接...", "Establishing SSH connection..."));

      dataDisposable = terminal.onData((data) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        void browserRuntime.writeSshSession(sessionId, data);
      });

      try {
        const activeTerminal = terminal;
        const sessionId = await browserRuntime.openSshSession({ ...request, cols: activeTerminal.cols, rows: activeTerminal.rows });
        if (disposed) {
          void browserRuntime.closeSshSession(sessionId);
          return;
        }
        sessionIdRef.current = sessionId;
        unlisten = await browserRuntime.onSshSessionEvent(sessionId, (event) => {
          if (event.kind === "output" && event.data) {
            activeTerminal.write(event.data);
            return;
          }
          if (event.kind === "status" && event.message) {
            setStatus(event.message);
            activeTerminal.writeln(`\r\n${event.message}`);
            return;
          }
          if (event.kind === "error") {
            const message = event.message ?? text("SSH 连接失败", "SSH connection failed");
            setStatus(message);
            activeTerminal.writeln(`\r\n${message}`);
            setCanReconnect(true);
            return;
          }
          if (event.kind === "closed") {
            setStatus(event.message ?? text("SSH 会话已关闭", "SSH session closed"));
            setCanReconnect(true);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : text("SSH 连接失败", "SSH connection failed");
        setStatus(message);
        terminal.writeln(`\r\n${message}`);
        setCanReconnect(true);
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("resize", resizeRemote);
      dataDisposable?.dispose();
      unlisten?.();
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) void browserRuntime.closeSshSession(sessionId).catch(() => {});
      termRef.current = null;
      terminal?.dispose();
    };
  }, [request, text, reconnectKey]);

  useEffect(() => {
    if (!request || isMinimized) return;
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
  }, [isMinimized, request]);

  const sendKeySeq = useCallback((rawKey: string, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (ctrlActiveRef.current && rawKey.length === 1 && /[a-zA-Z]/.test(rawKey)) {
      const code = rawKey.toLowerCase().charCodeAt(0) - 96;
      void browserRuntime.writeSshSession(sid, String.fromCharCode(code));
      ctrlActiveRef.current = false;
      setCtrlActive(false);
    } else {
      void browserRuntime.writeSshSession(sid, data);
    }
  }, []);

  if (!request) return null;

  const handleReconnect = () => {
    setCanReconnect(false);
    setReconnectKey((key) => key + 1);
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      const activeElement = document.activeElement;
      const isTerminalFocused = activeElement?.closest(".xterm") ?? false;
      if (!isTerminalFocused || event.ctrlKey) {
        event.preventDefault();
        onClose();
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
        aria-describedby={statusId}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="app-terminal-modal-panel max-h-[calc(100vh-5rem)] w-full max-w-5xl overflow-hidden rounded-lg bg-app-terminalBg">
          <div className="flex h-12 items-center justify-between border-b border-app-border bg-app-surface px-4">
            <div className="flex min-w-0 items-center gap-2 text-app-text">
              <Terminal className="h-4 w-4 shrink-0 text-app-accent" />
              <h2 id={titleId} className="truncate text-sm font-semibold">{text("应用内 SSH", "In-app SSH")} {request.taskName ?? ""}</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                title={text("最小化", "Minimize")}
                onClick={() => setIsMinimized(true)}
              >
                <Minimize2 className="h-4 w-4" />
                <span className="sr-only">{text("最小化", "Minimize")}</span>
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                title={text("关闭", "Close")}
                onClick={onClose}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{text("关闭", "Close")}</span>
              </button>
            </div>
          </div>
          <div className="flex h-[min(80vh,780px)] flex-col">
            <div className="flex h-10 items-center justify-between border-b border-app-terminalBorder bg-app-terminalPanel px-3 text-xs text-app-terminalText">
              <span className="truncate font-mono">{request.command}</span>
              <span id={statusId} className="ml-3 shrink-0 text-app-terminalAccent">{status}</span>
            </div>
            <div ref={containerRef} className="min-h-0 flex-1" />
            {browserRuntime.isMobile && (
              <div className="flex h-11 shrink-0 select-none items-center gap-1 overflow-x-auto border-t border-app-terminalBorder bg-app-terminalPanel px-1.5">
                {(["Esc", "Tab", "↑", "↓", "←", "→", "Ctrl"] as const).map((label) => {
                  const isCtrl = label === "Ctrl";
                  return (
                    <button
                      key={label}
                      className={cn(
                        "flex h-8 min-w-9 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px]",
                        isCtrl && ctrlActive
                          ? "bg-app-accent text-white"
                          : "text-app-terminalText hover:bg-app-panel",
                      )}
                      type="button"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        if (isCtrl) {
                          const next = !ctrlActiveRef.current;
                          ctrlActiveRef.current = next;
                          setCtrlActive(next);
                          setTimeout(() => termRef.current?.focus(), 0);
                        } else {
                          const sequences: Record<string, [string, string]> = {
                            "Esc": ["Esc", "\x1b"],
                            "Tab": ["Tab", "\x09"],
                            "↑": ["Up", "\x1b[A"],
                            "↓": ["Down", "\x1b[B"],
                            "←": ["Left", "\x1b[D"],
                            "→": ["Right", "\x1b[C"],
                          };
                          const seq = sequences[label];
                          if (seq) sendKeySeq(seq[0], seq[1]);
                          setTimeout(() => termRef.current?.focus(), 0);
                        }
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
                <div className="mx-0.5 h-5 w-px shrink-0 bg-app-terminalBorder" />
                {(["Ctrl+C", "Ctrl+Z", "Ctrl+D", "Ctrl+L"] as const).map((combo) => {
                  const charCode = combo.toLowerCase().charCodeAt(combo.length - 1) - 96;
                  return (
                    <button
                      key={combo}
                      className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-panel"
                      type="button"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        const sid = sessionIdRef.current;
                        if (sid) void browserRuntime.writeSshSession(sid, String.fromCharCode(charCode));
                        setTimeout(() => termRef.current?.focus(), 0);
                      }}
                    >
                      {combo}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex h-11 items-center justify-end gap-2 border-t border-app-terminalBorder bg-app-terminalPanel px-3">
              {canReconnect ? (
                <Button type="button" variant="secondary" onClick={handleReconnect}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {text("重连", "Reconnect")}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={onClose}>
                {text("关闭", "Close")}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {isMinimized ? (
        <button
          className="fixed bottom-4 right-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-app-terminalBorder bg-app-terminalBg px-4 py-3 text-left text-app-terminalText shadow-popover hover:bg-app-terminalPanel"
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}
          aria-label={text(`恢复应用内 SSH ${request.taskName ?? ""}`, `Restore in-app SSH ${request.taskName ?? ""}`)}
          type="button"
          onClick={() => setIsMinimized(false)}
        >
          <Terminal className="h-4 w-4 shrink-0 text-app-terminalAccent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{request.taskName ?? text("应用内 SSH", "In-app SSH")}</span>
            <span className="mt-1 block truncate text-xs text-app-terminalMuted">{status}</span>
          </span>
          <Maximize2 className="h-4 w-4 shrink-0 text-app-terminalMuted" />
        </button>
      ) : null}
    </>,
    document.body,
  );
}
