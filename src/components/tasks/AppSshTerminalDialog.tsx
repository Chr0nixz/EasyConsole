import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { browserRuntime } from "../../lib/runtime";
import type { SshConnectionRequest } from "../../lib/types";
import { Button, Dialog } from "../ui";

type AppSshTerminalDialogProps = {
  request: SshConnectionRequest | null;
  onClose: () => void;
};

export function AppSshTerminalDialog({ request, onClose }: AppSshTerminalDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState("准备连接");

  useEffect(() => {
    if (!request || !containerRef.current) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let terminal: XTermInstance | null = null;
    let fitAddon: FitAddonInstance | null = null;
    let dataDisposable: IDisposable | null = null;

    const resizeRemote = () => {
      if (!terminal || !fitAddon) return;
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
          background: "#0f172a",
          foreground: "#e2e8f0",
          cursor: "#38bdf8",
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

  return (
    <Dialog open={Boolean(request)} title={`应用内 SSH ${request?.taskName ?? ""}`} onClose={onClose} width="max-w-5xl">
      <div className="flex h-[min(72vh,720px)] flex-col bg-slate-950">
        <div className="flex h-10 items-center justify-between border-b border-slate-800 px-3 text-xs text-slate-300">
          <span className="truncate font-mono">{request?.command}</span>
          <span className="ml-3 shrink-0">{status}</span>
        </div>
        <div ref={containerRef} className="min-h-0 flex-1" />
        <div className="flex h-11 items-center justify-end border-t border-slate-800 px-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
