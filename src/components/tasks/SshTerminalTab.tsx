import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { SearchAddon as SearchAddonInstance } from "@xterm/addon-search";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { ChevronDown, ChevronUp, Circle, FolderOpen, Network, RefreshCw, Search, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeSettings, type SshTerminalTheme } from "../../lib/app-settings";
import { browserRuntime } from "../../lib/runtime";
import { saveBlob } from "../../lib/download";
import { useI18n } from "../../lib/i18n";
import type { PortForwardRule, PortForwardStatus, SshConnectionRequest, SshHostKeyPrompt } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button, Dialog } from "../ui";
import { SftpPanel } from "./SftpPanel";

type SshTerminalTabProps = {
  request: SshConnectionRequest;
  tabId: string;
  active: boolean;
  onStatusChange: (status: string) => void;
};

type StatusKind = "ready" | "connected" | "failed" | "closed";

function resolveTerminalTheme(theme: SshTerminalTheme) {
  switch (theme) {
    case "light":
      return {
        background: "oklch(0.98 0.005 255)",
        foreground: "oklch(0.2 0.02 255)",
        cursor: "oklch(0.3 0.15 235)",
      };
    case "hacker":
      return {
        background: "oklch(0.05 0.01 145)",
        foreground: "oklch(0.85 0.2 145)",
        cursor: "oklch(0.9 0.25 145)",
      };
    case "custom": {
      const colors = getRuntimeSettings().ssh.terminal.customColors;
      return {
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        selection: colors.selection,
        black: colors.black,
        red: colors.red,
        green: colors.green,
        yellow: colors.yellow,
        blue: colors.blue,
        magenta: colors.magenta,
        cyan: colors.cyan,
        white: colors.white,
        brightBlack: colors.brightBlack,
        brightRed: colors.brightRed,
        brightGreen: colors.brightGreen,
        brightYellow: colors.brightYellow,
        brightBlue: colors.brightBlue,
        brightMagenta: colors.brightMagenta,
        brightCyan: colors.brightCyan,
        brightWhite: colors.brightWhite,
      };
    }
    case "dark":
    default:
      return {
        background: "oklch(0.18 0.028 255)",
        foreground: "oklch(0.9 0.018 255)",
        cursor: "oklch(0.78 0.12 235)",
      };
  }
}

export function SshTerminalTab({ request, tabId, active, onStatusChange }: SshTerminalTabProps) {
  const { t, text } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState(() => text("准备连接", "Ready to connect"));
  const [statusKind, setStatusKind] = useState<StatusKind>("ready");
  const [ctrlActive, setCtrlActive] = useState(false);
  const [canReconnect, setCanReconnect] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [showSftp, setShowSftp] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPortForward, setShowPortForward] = useState(false);
  const [portForwardStatuses, setPortForwardStatuses] = useState<Record<string, PortForwardStatus>>({});
  const [hostKeyPrompt, setHostKeyPrompt] = useState<SshHostKeyPrompt | null>(null);
  const [hostKeyPending, setHostKeyPending] = useState(false);
  const ctrlActiveRef = useRef(false);
  const isRecordingRef = useRef(false);
  const activeRef = useRef(active);
  const logBufferRef = useRef<string[]>([]);
  const termRef = useRef<XTermInstance | null>(null);
  const searchAddonRef = useRef<SearchAddonInstance | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Port forwarding rules come from runtime settings. Re-read on each render
  // so newly added rules in SettingsPage are reflected when the panel reopens.
  const portForwardRules: PortForwardRule[] = getRuntimeSettings().ssh.portForwards;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    onStatusChange(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (active) {
      window.setTimeout(() => {
        termRef.current?.focus();
        if (containerRef.current) {
          window.dispatchEvent(new Event("resize"));
        }
      }, 0);
    }
  }, [active]);

  function toggleRecording() {
    if (isRecording) {
      const buffer = logBufferRef.current.join("");
      logBufferRef.current = [];
      setIsRecording(false);
      const settings = getRuntimeSettings().ssh;
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const taskName = request.taskName || "ssh";
      const filename = settings.terminal.logAutoName
        ? `${taskName}-${stamp}.log`
        : `ssh-log-${stamp}.log`;
      saveBlob(new Blob([buffer], { type: "text/plain" }), filename);
    } else {
      logBufferRef.current = [];
      setIsRecording(true);
    }
  }

  useEffect(() => {
    setStatus(text("准备连接", "Ready to connect"));
    setStatusKind("ready");
    setCanReconnect(false);
    setIsRecording(false);
    logBufferRef.current = [];
  }, [request, text]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenPf: (() => void) | null = null;
    let terminal: XTermInstance | null = null;
    let fitAddon: FitAddonInstance | null = null;
    let dataDisposable: IDisposable | null = null;

    const sshTerminal = getRuntimeSettings().ssh.terminal;

    const resizeRemote = () => {
      if (!terminal || !fitAddon || !activeRef.current) return;
      // Skip when the container is hidden (display:none) — dimensions are 0.
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fitAddon.fit();
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      void browserRuntime.resizeSshSession(sessionId, terminal.cols, terminal.rows);
    };

    // Debounce resize to avoid excessive fit() calls during panel transitions
    // or continuous window resize. xterm's fit() is expensive and rapid calls
    // can cause text corruption when the remote PTY hasn't caught up yet.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        resizeRemote();
      }, 80);
    };

    window.addEventListener("resize", scheduleResize);

    // Observe container dimension changes (SFTP/port-forward panel toggle,
    // tab switching, layout shifts) that window resize does not cover.
    // Without this, xterm's internal cols/rows become stale relative to the
    // visible area, causing text to render incorrectly when scrolling.
    const resizeObserver = new ResizeObserver(() => {
      scheduleResize();
    });
    resizeObserver.observe(containerRef.current);

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !containerRef.current) return;

      terminal = new XTerm({
        cursorBlink: sshTerminal.cursorBlink,
        convertEol: true,
        fontFamily: sshTerminal.fontFamily,
        fontSize: browserRuntime.isMobile ? Math.max(sshTerminal.fontSize, 15) : sshTerminal.fontSize,
        scrollback: sshTerminal.scrollback,
        theme: resolveTerminalTheme(sshTerminal.theme),
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      if (sshTerminal.webglRenderer) {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => webglAddon.dispose());
          terminal.loadAddon(webglAddon);
        } catch {
          // WebGL not available, fallback to canvas renderer
        }
      }
      if (sshTerminal.webLinks) {
        try {
          const { WebLinksAddon } = await import("@xterm/addon-web-links");
          terminal.loadAddon(new WebLinksAddon());
        } catch {
          // WebLinks addon not available
        }
      }
      try {
        const { SearchAddon } = await import("@xterm/addon-search");
        const searchAddon = new SearchAddon();
        terminal.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
      } catch {
        // Search addon not available
      }
      termRef.current = terminal;
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;
        if (event.key === "c" || event.key === "C") {
          const selection = terminal!.getSelection();
          if (selection) {
            void browserRuntime.copyText(selection);
            return false;
          }
          return true;
        }
        if (event.key === "v" || event.key === "V") {
          void browserRuntime.readClipboardText()
            .then((clipText) => {
              const sid = sessionIdRef.current;
              if (sid && clipText) void browserRuntime.writeSshSession(sid, clipText);
            })
            .catch(() => {});
          return false;
        }
        if (event.key === "f" || event.key === "F") {
          setShowSearch(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return false;
        }
        return true;
      });
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
      if (activeRef.current) terminal.focus();
      terminal.writeln(text("正在建立 SSH 连接...", "Establishing SSH connection..."));

      dataDisposable = terminal.onData((data) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        void browserRuntime.writeSshSession(sessionId, data);
      });

      try {
        const activeTerminal = terminal;
        const sshSettings = getRuntimeSettings().ssh;
        const sessionId = await browserRuntime.openSshSession({
          ...request,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          connectTimeoutSec: sshSettings.connectTimeoutSec,
          keepaliveIntervalSec: sshSettings.keepaliveIntervalSec,
          termType: sshSettings.termType,
          sshKeyPath: sshSettings.sshKeyPath || undefined,
          authMode: sshSettings.authMode,
        });
        if (disposed) {
          void browserRuntime.closeSshSession(sessionId);
          return;
        }
        sessionIdRef.current = sessionId;
        setSessionId(sessionId);
        let historyRecorded = false;
        unlisten = await browserRuntime.onSshSessionEvent(sessionId, (event) => {
          if (event.kind === "output" && event.data) {
            activeTerminal.write(event.data);
            // xterm only auto-scrolls when the viewport is already at the
            // bottom; if the user scrolled up (or the viewport was nudged by
            // a resize/fit cycle), writes would stack above the fold. Force
            // scroll to bottom on every output so the prompt stays visible.
            activeTerminal.scrollToBottom();
            if (isRecordingRef.current) {
              logBufferRef.current.push(event.data);
            }
            return;
          }
          if (event.kind === "status" && event.message) {
            setStatus(event.message);
            setStatusKind("connected");
            activeTerminal.writeln(`\r\n${event.message}`);
            if (!historyRecorded && event.message.includes("已连接")) {
              historyRecorded = true;
              void browserRuntime.addSshHistory({
                host: request.host,
                port: request.port ?? "",
                username: request.username ?? "",
                taskName: request.taskName ?? "",
              });
            }
            return;
          }
          if (event.kind === "host-key-prompt" && event.data) {
            try {
              const payload = JSON.parse(event.data) as SshHostKeyPrompt;
              setHostKeyPrompt(payload);
              setStatus(event.message ?? text("等待确认主机指纹", "Waiting for host key confirmation"));
              setStatusKind("ready");
              activeTerminal.writeln(
                `\r\n${event.message ?? text("首次连接，请确认主机指纹。", "First connection — confirm the host fingerprint.")}`,
              );
            } catch {
              setStatus(text("主机密钥提示无效", "Invalid host key prompt"));
              setStatusKind("failed");
            }
            return;
          }
          if (event.kind === "error") {
            const message = event.message ?? text("SSH 连接失败", "SSH connection failed");
            setStatus(message);
            setStatusKind("failed");
            activeTerminal.writeln(`\r\n${message}`);
            setCanReconnect(true);
            return;
          }
          if (event.kind === "closed") {
            setStatus(event.message ?? text("SSH 会话已关闭", "SSH session closed"));
            setStatusKind("closed");
            setCanReconnect(true);
          }
        });
        // Listen for port-forward-status events to update the UI state.
        unlistenPf = await browserRuntime.onPortForwardStatus(sessionId, (pfStatus) => {
          setPortForwardStatuses((prev) => ({ ...prev, [pfStatus.ruleId]: pfStatus }));
        });
        // Auto-start enabled port forwarding rules from settings once connected.
        if (!disposed) {
          const enabledRules = getRuntimeSettings().ssh.portForwards.filter((r) => r.enabled);
          for (const rule of enabledRules) {
            void browserRuntime.startPortForward(sessionId, rule).catch((error) => {
              setPortForwardStatuses((prev) => ({
                ...prev,
                [rule.id]: {
                  ruleId: rule.id,
                  active: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              }));
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : text("SSH 连接失败", "SSH connection failed");
        setStatus(message);
        setStatusKind("failed");
        terminal.writeln(`\r\n${message}`);
        setCanReconnect(true);
      }
    })();

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener("resize", scheduleResize);
      resizeObserver.disconnect();
      dataDisposable?.dispose();
      unlisten?.();
      unlistenPf?.();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      setSessionId(null);
      setPortForwardStatuses({});
      if (sid) void browserRuntime.closeSshSession(sid).catch(() => {});
      termRef.current = null;
      searchAddonRef.current = null;
      terminal?.dispose();
    };
  }, [request, text, reconnectKey]);

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

  const handleSearch = useCallback((direction: "next" | "prev") => {
    const addon = searchAddonRef.current;
    if (!addon || !searchQuery) return;
    if (direction === "next") {
      addon.findNext(searchQuery);
    } else {
      addon.findPrevious(searchQuery);
    }
  }, [searchQuery]);

  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else {
        setSearchQuery("");
        searchAddonRef.current?.clearDecorations?.();
        setTimeout(() => termRef.current?.focus(), 0);
      }
      return next;
    });
  }, []);

  const handleReconnect = () => {
    setCanReconnect(false);
    setReconnectKey((key) => key + 1);
  };

  const statusColorClass =
    statusKind === "connected" ? "text-app-success" : statusKind === "failed" ? "text-app-danger" : "text-app-terminalMuted";

  return (
    <div className={cn("flex h-full flex-col", !active && "hidden")} data-tab-id={tabId}>
      <div className="flex h-10 items-center justify-between border-b border-app-terminalBorder bg-app-terminalPanel px-3 text-xs text-app-terminalText">
        <span className="truncate font-mono">{request.command}</span>
        <div className="flex items-center gap-2">
          <button
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent",
              showSearch ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
            )}
            type="button"
            title={text("搜索 (Ctrl+F)", "Search (Ctrl+F)")}
            aria-label={text("搜索 (Ctrl+F)", "Search (Ctrl+F)")}
            onClick={toggleSearch}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent",
              isRecording ? "text-red-500 hover:bg-app-terminalBg" : "text-app-terminalText hover:bg-app-terminalBg",
            )}
            type="button"
            title={isRecording ? t("terminal.stopRecording") : t("terminal.record")}
            aria-label={isRecording ? t("terminal.stopRecording") : t("terminal.record")}
            onClick={toggleRecording}
          >
            {isRecording ? <Square className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </button>
          {browserRuntime.supportsInAppSsh ? (
            <button
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent",
                showSftp ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={t("sftp.title")}
              aria-label={t("sftp.title")}
              onClick={() => setShowSftp((prev) => !prev)}
              disabled={!sessionId}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {browserRuntime.supportsInAppSsh ? (
            <button
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent",
                showPortForward ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={t("terminal.portForwards")}
              aria-label={t("terminal.portForwards")}
              onClick={() => setShowPortForward((prev) => !prev)}
              disabled={!sessionId}
            >
              <Network className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {isRecording ? (
            <span className="flex items-center gap-1 text-xs text-red-500">
              <Circle className="h-2 w-2 animate-pulse fill-current" />
              {t("terminal.recording")}
            </span>
          ) : null}
          <span className={cn("shrink-0", statusColorClass)}>{status}</span>
        </div>
      </div>
      {showSearch ? (
        <div className="flex h-9 items-center gap-1.5 border-b border-app-terminalBorder bg-app-terminalPanel px-3">
          <input
            ref={searchInputRef}
            className="h-6 min-w-0 flex-1 rounded bg-app-terminalBg px-2 text-xs text-app-terminalText outline-none ring-1 ring-app-terminalBorder focus:ring-app-accent"
            type="text"
            placeholder={text("搜索...", "Search...")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleSearch(event.shiftKey ? "prev" : "next");
              } else if (event.key === "Escape") {
                event.preventDefault();
                toggleSearch();
              }
            }}
          />
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            type="button"
            title={text("上一个", "Previous")}
            aria-label={text("上一个", "Previous")}
            onClick={() => handleSearch("prev")}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            type="button"
            title={text("下一个", "Next")}
            aria-label={text("下一个", "Next")}
            onClick={() => handleSearch("next")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            type="button"
            title={text("关闭", "Close")}
            aria-label={text("关闭", "Close")}
            onClick={toggleSearch}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="min-h-0 flex-1" />
        {showSftp && sessionId ? (
          <div className="w-80 shrink-0 border-l border-app-terminalBorder">
            <SftpPanel sessionId={sessionId} />
          </div>
        ) : null}
        {showPortForward && sessionId ? (
          <div className="w-80 shrink-0 border-l border-app-terminalBorder bg-app-terminalPanel p-3 text-xs text-app-terminalText">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium">{t("terminal.portForwards")}</span>
              <button
                className="flex h-5 w-5 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
                type="button"
                title={text("关闭", "Close")}
                aria-label={text("关闭", "Close")}
                onClick={() => setShowPortForward(false)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {portForwardRules.length === 0 ? (
              <div className="py-4 text-center text-app-terminalMuted">{t("settings.sshPortForwardEmpty")}</div>
            ) : (
              <div className="space-y-2">
                {portForwardRules.map((rule) => {
                  const status = portForwardStatuses[rule.id];
                  const active = status?.active === true;
                  return (
                    <div key={rule.id} className="rounded-md border border-app-terminalBorder bg-app-terminalBg p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded bg-app-terminalPanel px-1 py-0.5 font-mono text-xs text-app-terminalAccent">
                              {rule.type === "local" ? "-L" : rule.type === "remote" ? "-R" : "-D"}
                            </span>
                            <span className="truncate font-mono text-app-terminalText">
                              {rule.localHost}:{rule.localPort}
                              {rule.type !== "dynamic" ? ` → ${rule.remoteHost}:${rule.remotePort}` : ""}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-xs text-app-terminalMuted">
                            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", active ? "bg-app-success" : "bg-app-terminalMuted")} />
                            {active ? t("terminal.portForwardActive") : t("terminal.portForwardInactive")}
                          </div>
                          {status?.error ? (
                            <div className="mt-1 break-all text-xs text-app-danger">{status.error}</div>
                          ) : null}
                        </div>
                        <button
                          className="shrink-0 rounded bg-app-terminalPanel px-2 py-1 text-xs text-app-terminalText hover:bg-app-terminalBorder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
                          type="button"
                          disabled={!sessionId}
                          onClick={() => {
                            if (!sessionId) return;
                            if (active) {
                              void browserRuntime.stopPortForward(sessionId, rule.id).catch(() => {});
                            } else {
                              void browserRuntime.startPortForward(sessionId, rule).catch(() => {});
                            }
                          }}
                        >
                          {active ? t("terminal.portForwardStop") : t("terminal.portForwardStart")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </div>
      {browserRuntime.isMobile && (
        <div className="flex h-11 shrink-0 select-none items-center gap-1 overflow-x-auto border-t border-app-terminalBorder bg-app-terminalPanel px-1.5">
          {(["Esc", "Tab", "↑", "↓", "←", "→", "Ctrl"] as const).map((label) => {
            const isCtrl = label === "Ctrl";
            return (
              <button
                key={label}
                className={cn(
                  "flex h-8 min-w-9 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent",
                  isCtrl && ctrlActive
                    ? "bg-app-accent text-white"
                    : "text-app-terminalText hover:bg-app-terminalBg",
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
                className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
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
          <div className="mx-0.5 h-5 w-px shrink-0 bg-app-terminalBorder" />
          <button
            className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              const selection = termRef.current?.getSelection();
              if (selection) void browserRuntime.copyText(selection);
              setTimeout(() => termRef.current?.focus(), 0);
            }}
          >
            {text("复制", "Copy")}
          </button>
          <button
            className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              void browserRuntime.readClipboardText()
                .then((clipText) => {
                  const sid = sessionIdRef.current;
                  if (sid && clipText) void browserRuntime.writeSshSession(sid, clipText);
                })
                .catch(() => {});
              setTimeout(() => termRef.current?.focus(), 0);
            }}
          >
            {text("粘贴", "Paste")}
          </button>
        </div>
      )}
      {canReconnect ? (
        <div className="flex h-11 items-center justify-end gap-2 border-t border-app-terminalBorder bg-app-terminalPanel px-3">
          <Button
            type="button"
            variant="secondary"
            className="border-app-terminalBorder bg-app-terminalBg text-app-terminalText hover:bg-app-terminalPanel"
            onClick={handleReconnect}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {text("重连", "Reconnect")}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={Boolean(hostKeyPrompt)}
        title={text("确认 SSH 主机密钥", "Confirm SSH Host Key")}
        width="max-w-md"
        closeOnOverlayClick={!hostKeyPending}
        onClose={() => {
          if (hostKeyPending || !hostKeyPrompt) return;
          const promptId = hostKeyPrompt.promptId;
          setHostKeyPending(true);
          void browserRuntime
            .confirmKnownHost(promptId, false)
            .catch(() => {})
            .finally(() => {
              setHostKeyPending(false);
              setHostKeyPrompt(null);
            });
        }}
      >
        <div className="space-y-4 p-4 text-sm">
          <p className="leading-6 text-app-muted">
            {text(
              "首次连接该主机。请核对指纹后再信任；错误指纹可能表示中间人攻击。",
              "First connection to this host. Verify the fingerprint before trusting it; a wrong fingerprint may indicate a man-in-the-middle attack.",
            )}
          </p>
          {hostKeyPrompt ? (
            <div className="space-y-2 rounded-md border border-app-border bg-app-panel px-3 py-2 font-mono text-xs">
              <div>
                <span className="text-app-muted">Host</span>
                <div className="mt-0.5 break-all text-app-text">
                  {hostKeyPrompt.host}:{hostKeyPrompt.port}
                </div>
              </div>
              <div>
                <span className="text-app-muted">Fingerprint</span>
                <div className="mt-0.5 break-all text-app-text">{hostKeyPrompt.fingerprint}</div>
              </div>
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end">
            <Button
              disabled={hostKeyPending}
              type="button"
              variant="secondary"
              onClick={() => {
                if (!hostKeyPrompt) return;
                const promptId = hostKeyPrompt.promptId;
                setHostKeyPending(true);
                void browserRuntime
                  .confirmKnownHost(promptId, false)
                  .catch(() => {})
                  .finally(() => {
                    setHostKeyPending(false);
                    setHostKeyPrompt(null);
                  });
              }}
            >
              {text("拒绝", "Reject")}
            </Button>
            <Button
              disabled={hostKeyPending}
              type="button"
              onClick={() => {
                if (!hostKeyPrompt) return;
                const promptId = hostKeyPrompt.promptId;
                setHostKeyPending(true);
                void browserRuntime
                  .confirmKnownHost(promptId, true)
                  .catch(() => {})
                  .finally(() => {
                    setHostKeyPending(false);
                    setHostKeyPrompt(null);
                  });
              }}
            >
              {hostKeyPending ? text("提交中", "Submitting") : text("信任并继续", "Trust and continue")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
