import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { browserRuntime, RUNTIME_SOCKET_OPEN } from "../../lib/runtime";
import { formatTerminalInput, formatTerminalResize, deriveWebsshUrl } from "../../lib/webssh";
import { getTaskName } from "../../lib/format";
import type { RuntimeWebSocket, Task } from "../../lib/types";
import { Button, Dialog } from "../ui";

export function TerminalDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<RuntimeWebSocket | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const [status, setStatus] = useState("未连接");

  useEffect(() => {
    if (!task || !containerRef.current) return;

    let disposed = false;
    const fit = new FitAddon();
    const terminal = new XTerm({
      convertEol: true,
      cursorStyle: "underline",
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        foreground: "#f8fafc",
        background: "#0f172a",
      },
    });

    terminalRef.current = terminal;
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();

    const dimensions = fit.proposeDimensions() ?? { cols: 80, rows: 24 };

    void browserRuntime.createWebSocket(deriveWebsshUrl(task.id, dimensions.cols, dimensions.rows)).then((socket) => {
      if (disposed) {
        void socket.close();
        return;
      }

      socketRef.current = socket;

      terminal.onData((data) => {
        if (socket.readyState === RUNTIME_SOCKET_OPEN) {
          void socket.send(formatTerminalInput(data));
        } else {
          terminal.writeln("\r\n连接已断开");
        }
      });

      terminal.onResize(({ cols, rows }) => {
        if (socket.readyState === RUNTIME_SOCKET_OPEN) void socket.send(formatTerminalResize(cols, rows));
      });

      socket.onopen = () => {
        setStatus("已连接");
        terminal.writeln(`当前实例 ${getTaskName(task)}`);
        terminal.write("\r\n$ ");
        terminal.focus();
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data as string) as { status: number; message?: string };
          if (payload.status === 0) terminal.write(payload.message ?? "");
          else {
            setStatus("已断开");
            terminal.writeln("\r\n实例 SSH 连接已断开");
          }
        } catch {
          terminal.write(String(event.data ?? ""));
        }
      };
      socket.onerror = () => {
        setStatus("连接错误");
        terminal.writeln("\r\n连接出错");
      };
      socket.onclose = () => setStatus("已断开");
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      void socketRef.current?.close();
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
    };
  }, [task]);

  return (
    <Dialog open={Boolean(task)} title={`终端 ${task ? getTaskName(task) : ""}`} onClose={onClose} width="max-w-6xl">
      <div className="flex h-[70vh] flex-col">
        <div className="flex h-10 items-center justify-between border-b border-app-border px-3 text-sm">
          <span className="text-app-muted">{status}</span>
          <Button variant="secondary" onClick={() => void socketRef.current?.close()}>
            断开
          </Button>
        </div>
        <div ref={containerRef} className="min-h-0 flex-1 bg-slate-950" />
      </div>
    </Dialog>
  );
}
