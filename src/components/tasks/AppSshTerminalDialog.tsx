import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { Maximize2, Minimize2, Terminal, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { browserRuntime } from "../../lib/runtime";
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
  const titleId = useId();
  const statusId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const isMinimizedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [status, setStatus] = useState("准备连接");

  useEffect(() => {
    isMinimizedRef.current = isMinimized;
  }, [isMinimized]);

  useEffect(() => {
    setIsMinimized(false);
    setStatus("准备连接");
  }, [request]);

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
        fontSize: 13,
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
      terminal.focus();
      terminal.writeln("正在建立 SSH 连接...");

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
            const message = event.message ?? "SSH 连接失败";
            setStatus(message);
            activeTerminal.writeln(`\r\n${message}`);
            return;
          }
          if (event.kind === "closed") {
            setStatus(event.message ?? "SSH 会话已关闭");
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "SSH 连接失败";
        setStatus(message);
        terminal.writeln(`\r\n${message}`);
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
      terminal?.dispose();
    };
  }, [request]);

  useEffect(() => {
    if (!request || isMinimized) return;
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
  }, [isMinimized, request]);

  if (!request) return null;

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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

  return (
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
              <h2 id={titleId} className="truncate text-sm font-semibold">应用内 SSH {request.taskName ?? ""}</h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                title="最小化"
                onClick={() => setIsMinimized(true)}
              >
                <Minimize2 className="h-4 w-4" />
                <span className="sr-only">最小化</span>
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-app-muted hover:bg-app-panel hover:text-app-text"
                type="button"
                title="关闭"
                onClick={onClose}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">关闭</span>
              </button>
            </div>
          </div>
          <div className="flex h-[min(72vh,720px)] flex-col">
            <div className="flex h-10 items-center justify-between border-b border-app-terminalBorder bg-app-terminalPanel px-3 text-xs text-app-terminalText">
              <span className="truncate font-mono">{request.command}</span>
              <span id={statusId} className="ml-3 shrink-0 text-app-terminalAccent">{status}</span>
            </div>
            <div ref={containerRef} className="min-h-0 flex-1" />
            <div className="flex h-11 items-center justify-end border-t border-app-terminalBorder bg-app-terminalPanel px-3">
              <Button type="button" variant="secondary" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      </div>

      {isMinimized ? (
        <button
          className="fixed bottom-4 right-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 rounded-lg border border-app-terminalBorder bg-app-terminalBg px-4 py-3 text-left text-app-terminalText shadow-popover hover:bg-app-terminalPanel"
          aria-label={`恢复应用内 SSH ${request.taskName ?? ""}`}
          type="button"
          onClick={() => setIsMinimized(false)}
        >
          <Terminal className="h-4 w-4 shrink-0 text-app-terminalAccent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{request.taskName ?? "应用内 SSH"}</span>
            <span className="mt-1 block truncate text-xs text-app-terminalMuted">{status}</span>
          </span>
          <Maximize2 className="h-4 w-4 shrink-0 text-app-terminalMuted" />
        </button>
      ) : null}
    </>
  );
}
