import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { SearchAddon as SearchAddonInstance } from "@xterm/addon-search";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { ChevronDown, ChevronUp, Circle, FolderOpen, MoreHorizontal, Network, RefreshCw, Search, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeSettings, type SshTerminalTheme } from "../../lib/app-settings";
import { browserRuntime } from "../../lib/runtime";
import { saveBlob } from "../../lib/download";
import { useI18n } from "../../lib/i18n";
import { useMobileBackLayer } from "../../lib/use-mobile-back-stack";
import {
  appendRecordingChunk,
  createRecordingBuffer,
  isNearTerminalBottom,
  type RecordingBufferState,
} from "../../lib/ssh-terminal-follow";
import type { PortForwardRule, PortForwardStatus, SshConnectionRequest, SshHostKeyPrompt } from "../../lib/types";
import { useToast } from "../../lib/use-toast";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
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
  const toast = useToast();
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
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [portForwardStatuses, setPortForwardStatuses] = useState<Record<string, PortForwardStatus>>({});
  const [hostKeyPrompt, setHostKeyPrompt] = useState<SshHostKeyPrompt | null>(null);
  const [hostKeyPending, setHostKeyPending] = useState(false);
  const [followBottom, setFollowBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const ctrlActiveRef = useRef(false);
  const isRecordingRef = useRef(false);
  const followBottomRef = useRef(true);
  const activeRef = useRef(active);
  const recordingBufferRef = useRef<RecordingBufferState>(createRecordingBuffer());
  const recordingCapNotifiedRef = useRef(false);
  const termRef = useRef<XTermInstance | null>(null);
  const searchAddonRef = useRef<SearchAddonInstance | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

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
    followBottomRef.current = followBottom;
  }, [followBottom]);

  // Keep a stable ref so status sync cannot re-trigger when the parent passes a
  // fresh inline `onStatusChange` each render (which would infinite-loop via setState).
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  // `text` from useI18n is recreated whenever the locale changes. The connection
  // effect below tears down its session on any dependency change, so depending on
  // `text` directly meant switching languages silently killed every live SSH
  // session and wiped its scrollback. Route translation through a ref instead.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const tt = useCallback((zh: string, en: string) => textRef.current(zh, en), []);
  useEffect(() => {
    onStatusChangeRef.current(status);
  }, [status]);

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

  const scrollTerminalToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    setFollowBottom(true);
    setHasNewOutput(false);
  }, []);

  function toggleRecording() {
    if (isRecording) {
      const buffer = recordingBufferRef.current.chunks.join("");
      recordingBufferRef.current = createRecordingBuffer();
      recordingCapNotifiedRef.current = false;
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
      recordingBufferRef.current = createRecordingBuffer();
      recordingCapNotifiedRef.current = false;
      setIsRecording(true);
    }
  }

  // Resets state for a new connection target. Depends on `request` only: keeping
  // `text` here meant a language switch also cleared the status of a live session
  // and silently discarded an in-progress recording.
  useEffect(() => {
    setStatus(tt("准备连接", "Ready to connect"));
    setStatusKind("ready");
    setCanReconnect(false);
    setIsRecording(false);
    setFollowBottom(true);
    setHasNewOutput(false);
    recordingBufferRef.current = createRecordingBuffer();
    recordingCapNotifiedRef.current = false;
  }, [request, tt]);

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
      terminal.onScroll(() => {
        if (!terminal) return;
        const nearBottom = isNearTerminalBottom(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
        followBottomRef.current = nearBottom;
        setFollowBottom(nearBottom);
        if (nearBottom) setHasNewOutput(false);
      });
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
          // Suppress \x16; native paste → onData handles clipboard once.
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
      terminal.writeln(tt("正在建立 SSH 连接...", "Establishing SSH connection..."));

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
            if (followBottomRef.current) {
              activeTerminal.scrollToBottom();
            } else {
              setHasNewOutput(true);
            }
            if (isRecordingRef.current) {
              const appended = appendRecordingChunk(recordingBufferRef.current, event.data);
              if (!appended && recordingBufferRef.current.capped && !recordingCapNotifiedRef.current) {
                recordingCapNotifiedRef.current = true;
                isRecordingRef.current = false;
                setIsRecording(false);
                toast.info(
                  tt("录制缓冲已满", "Recording buffer full"),
                  tt("已停止追加录制内容；请停止录制以保存已捕获部分。", "Stopped appending; stop recording to save what was captured."),
                );
              }
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
              setStatus(event.message ?? tt("等待确认主机指纹", "Waiting for host key confirmation"));
              setStatusKind("ready");
              activeTerminal.writeln(
                `\r\n${event.message ?? tt("首次连接，请确认主机指纹。", "First connection — confirm the host fingerprint.")}`,
              );
            } catch {
              setStatus(tt("主机密钥提示无效", "Invalid host key prompt"));
              setStatusKind("failed");
            }
            return;
          }
          if (event.kind === "error") {
            const message = event.message ?? tt("SSH 连接失败", "SSH connection failed");
            setStatus(message);
            setStatusKind("failed");
            activeTerminal.writeln(`\r\n${message}`);
            setCanReconnect(true);
            return;
          }
          if (event.kind === "closed") {
            setStatus(event.message ?? tt("SSH 会话已关闭", "SSH session closed"));
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
        const message = error instanceof Error ? error.message : tt("SSH 连接失败", "SSH connection failed");
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
  }, [request, reconnectKey, tt, toast]);

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

  const respondHostKey = (accept: boolean) => {
    if (hostKeyPending || !hostKeyPrompt) return;
    const promptId = hostKeyPrompt.promptId;
    setHostKeyPending(true);
    void browserRuntime
      .confirmKnownHost(promptId, accept)
      .catch(() => {})
      .finally(() => {
        setHostKeyPending(false);
        setHostKeyPrompt(null);
      });
  };

  const statusColorClass =
    statusKind === "connected" ? "text-app-success" : statusKind === "failed" ? "text-app-danger" : "text-app-terminalMuted";

  const closeToolMenu = useCallback(() => {
    setShowToolMenu(false);
    window.setTimeout(() => toolMenuTriggerRef.current?.focus(), 0);
  }, []);

  useMobileBackLayer(showToolMenu, closeToolMenu);

  return (
    <div
      id={`ssh-terminal-panel-${tabId}`}
      className={cn("relative flex h-full flex-col", !active && "hidden")}
      data-tab-id={tabId}
      role="tabpanel"
      aria-labelledby={`ssh-tab-${tabId}`}
      hidden={!active}
    >
      <div className="flex h-12 items-center justify-between gap-2 border-b border-app-terminalBorder bg-app-terminalPanel px-3 text-xs text-app-terminalText md:h-10">
        <span className="min-w-0 flex-1 truncate font-mono">{request.command}</span>
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          <div className="hidden items-center gap-2 md:flex">
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
              aria-expanded={showSftp}
              aria-controls={`ssh-sftp-panel-${tabId}`}
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
              aria-expanded={showPortForward}
              aria-controls={`ssh-port-forward-panel-${tabId}`}
              onClick={() => setShowPortForward((prev) => !prev)}
              disabled={!sessionId}
            >
              <Network className="h-3.5 w-3.5" />
            </button>
          ) : null}
          </div>
          {browserRuntime.supportsInAppSsh ? (
            <button
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent md:hidden",
                showSftp ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={t("sftp.title")}
              aria-label={t("sftp.title")}
              aria-expanded={showSftp}
              aria-controls={`ssh-sftp-panel-${tabId}`}
              onClick={() => setShowSftp((prev) => !prev)}
              disabled={!sessionId}
            >
              <FolderOpen className="h-4 w-4" />
            </button>
          ) : null}
          <button
            ref={toolMenuTriggerRef}
            className="flex h-11 w-11 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent md:hidden"
            type="button"
            title={text("更多终端工具", "More terminal tools")}
            aria-label={text("更多终端工具", "More terminal tools")}
            aria-haspopup="menu"
            aria-expanded={showToolMenu}
            aria-controls={`ssh-terminal-tools-${tabId}`}
            onClick={() => setShowToolMenu((open) => !open)}
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {isRecording ? (
            <span className="hidden items-center gap-1 text-xs text-red-500 md:flex">
              <Circle className="h-2 w-2 animate-pulse fill-current" />
              {t("terminal.recording")}
            </span>
          ) : null}
          <span className={cn("hidden shrink-0 md:inline", statusColorClass)}>{status}</span>
          <span className={cn("h-2 w-2 shrink-0 rounded-full md:hidden", statusKind === "connected" ? "bg-app-success" : statusKind === "failed" ? "bg-app-danger" : "bg-app-terminalMuted")} aria-label={status} />
        </div>
      </div>
      {showToolMenu ? (
        <div
          className="absolute inset-0 z-30 flex items-end bg-black/40 md:hidden"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeToolMenu();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeToolMenu();
            }
          }}
        >
          <div id={`ssh-terminal-tools-${tabId}`} className="w-full rounded-t-lg border border-b-0 border-app-terminalBorder bg-app-terminalPanel p-2 shadow-popover" role="menu" aria-label={text("终端工具", "Terminal tools")}>
            <button
              className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
              type="button"
              role="menuitem"
              onClick={() => {
                toggleSearch();
                closeToolMenu();
              }}
            >
              <Search className="h-4 w-4" />
              {text("搜索终端输出", "Search terminal output")}
            </button>
            <button
              className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
              type="button"
              role="menuitem"
              onClick={() => {
                toggleRecording();
                closeToolMenu();
              }}
            >
              {isRecording ? <Square className="h-4 w-4 text-app-danger" /> : <Circle className="h-4 w-4" />}
              {isRecording ? t("terminal.stopRecording") : t("terminal.record")}
            </button>
            {browserRuntime.supportsInAppSsh ? (
              <button
                className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-40"
                type="button"
                role="menuitem"
                aria-expanded={showPortForward}
                aria-controls={`ssh-port-forward-panel-${tabId}`}
                disabled={!sessionId}
                onClick={() => {
                  setShowPortForward((open) => !open);
                  closeToolMenu();
                }}
              >
                <Network className="h-4 w-4" />
                {t("terminal.portForwards")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
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
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <div ref={containerRef} className="h-full min-h-0" />
          {!followBottom && hasNewOutput ? (
            <button
              type="button"
              className="absolute bottom-3 right-3 z-10 rounded-md bg-app-accent px-2.5 py-1.5 text-xs font-medium text-white shadow-shell hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
              onClick={scrollTerminalToBottom}
            >
              {text("有新输出 · 回到底部", "New output · Jump to bottom")}
            </button>
          ) : null}
        </div>
        {showSftp && sessionId ? (
          <div
            id={`ssh-sftp-panel-${tabId}`}
            className="absolute inset-0 z-20 flex min-h-0 w-full flex-col border-l border-app-terminalBorder bg-app-surface md:static md:z-auto md:w-80 md:shrink-0"
            role="region"
            aria-label={t("sftp.title")}
          >
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-app-terminalBorder px-3 text-xs text-app-terminalText md:hidden">
              <span className="font-medium">{t("sftp.title")}</span>
              <button
                className="flex h-8 w-8 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
                type="button"
                title={text("关闭", "Close")}
                aria-label={text("关闭", "Close")}
                onClick={() => setShowSftp(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SftpPanel sessionId={sessionId} />
            </div>
          </div>
        ) : null}
        {showPortForward && sessionId ? (
          <div
            id={`ssh-port-forward-panel-${tabId}`}
            className="absolute inset-0 z-20 flex min-h-0 w-full flex-col overflow-auto border-l border-app-terminalBorder bg-app-terminalPanel p-3 text-xs text-app-terminalText md:static md:z-auto md:w-80 md:shrink-0"
            role="region"
            aria-label={t("terminal.portForwards")}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium">{t("terminal.portForwards")}</span>
              <button
                className="flex h-11 w-11 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent md:h-5 md:w-5"
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
                  if (clipText) termRef.current?.paste(clipText);
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
      {hostKeyPrompt ? (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`ssh-host-key-title-${tabId}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              respondHostKey(false);
            }
          }}
        >
          <div className="w-full max-w-md space-y-4 rounded-lg border border-app-border bg-app-surface p-4 text-sm shadow-popover">
            <div>
              <h3 id={`ssh-host-key-title-${tabId}`} className="text-sm font-semibold text-app-text">
                {text("确认 SSH 主机密钥", "Confirm SSH Host Key")}
              </h3>
              <p className="mt-2 leading-6 text-app-muted">
                {text(
                  "首次连接该主机。请核对指纹后再信任；错误指纹可能表示中间人攻击。",
                  "First connection to this host. Verify the fingerprint before trusting it; a wrong fingerprint may indicate a man-in-the-middle attack.",
                )}
              </p>
            </div>
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
            <div className="flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end">
              <Button
                disabled={hostKeyPending}
                type="button"
                variant="secondary"
                onClick={() => respondHostKey(false)}
              >
                {text("拒绝", "Reject")}
              </Button>
              <Button
                disabled={hostKeyPending}
                type="button"
                autoFocus
                onClick={() => respondHostKey(true)}
              >
                {hostKeyPending ? text("提交中", "Submitting") : text("信任并继续", "Trust and continue")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
