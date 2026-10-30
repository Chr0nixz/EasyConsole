import "@xterm/xterm/css/xterm.css";

import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { SearchAddon as SearchAddonInstance } from "@xterm/addon-search";
import type { IDisposable, Terminal as XTermInstance } from "@xterm/xterm";
import { ChevronDown, ChevronUp, Circle, FolderOpen, MoreHorizontal, Network, RefreshCw, Search, Square, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeSettings, portForwardRuleAppliesToHost, type SshTerminalPreferences, type SshTerminalTheme } from "../../lib/app-settings";
import { browserRuntime } from "../../lib/runtime";
import { resolveBuiltinTerminalTheme, SSH_SEARCH_DECORATIONS } from "../../lib/ssh-terminal-colors";
import { saveBlob } from "../../lib/download";
import { useI18n } from "../../lib/i18n";
import { useMobileBackLayer } from "../../lib/use-mobile-back-stack";
import { claimOverlayKey, useOverlay } from "../../lib/overlay-stack";
import { resolveSshConnectionRequest } from "../../lib/ssh-info";
import { composeMobileControl } from "../../lib/ssh-terminal-input";
import {
  appendRecordingChunk,
  createRecordingBuffer,
  isNearTerminalBottom,
  serializeTerminalBuffer,
  type RecordingBufferState,
} from "../../lib/ssh-terminal-follow";
import type { PortForwardRule, PortForwardStatus, SshConnectionRequest, SshHostKeyPrompt, SshSessionPhase, SshTabStatusKind } from "../../lib/types";
import { useToast } from "../../lib/use-toast";
import { cn } from "../../lib/utils";
import { Button } from "../ui";
import { SftpPanel } from "./SftpPanel";

type SshTerminalTabProps = {
  request: SshConnectionRequest;
  tabId: string;
  active: boolean;
  onStatusChange: (status: string, kind: StatusKind) => void;
  preferences?: SshTerminalPreferences;
};

/** Canonical definition lives in lib/types.ts so lib modules can use it. */
export type StatusKind = SshTabStatusKind;

/** Mirrors HOST_KEY_PROMPT_TIMEOUT_SECS on the native side. */
const HOST_KEY_PROMPT_TIMEOUT_SECS = 120;

/** Replay chunk size (rows) for preserved scrollback, so large histories do not block one write. */
const RECONNECT_REPLAY_CHUNK_ROWS = 500;

function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusKindFromPhase(phase: SshSessionPhase | undefined): StatusKind {
  switch (phase) {
    case "connected":
      return "connected";
    case "exited":
      return "closed";
    case "connecting":
    default:
      return "ready";
  }
}

function resolveTerminalTheme(theme: SshTerminalTheme, customColors = getRuntimeSettings().ssh.terminal.customColors) {
  switch (theme) {
    case "light":
      return resolveBuiltinTerminalTheme("light");
    case "hacker":
      return resolveBuiltinTerminalTheme("hacker");
    case "custom": {
      const colors = customColors;
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
      return resolveBuiltinTerminalTheme("dark");
  }
}

export function SshTerminalTab({ request, tabId, active, onStatusChange, preferences }: SshTerminalTabProps) {
  const { text } = useI18n();
  const toast = useToast();
  const sftpLabel = text("SFTP 远程文件", "SFTP Remote Files");
  const portForwardsLabel = text("端口转发", "Port forwards");
  const disconnectedHint = text("SSH 连接建立后可用", "Available once the SSH connection is established");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState(() => text("正在建立连接...", "Connecting..."));
  const [statusKind, setStatusKind] = useState<StatusKind>("ready");
  const [ctrlActive, setCtrlActive] = useState(false);
  const [canReconnect, setCanReconnect] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<{ index: number; count: number } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [showSftp, setShowSftp] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPortForward, setShowPortForward] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [portForwardStatuses, setPortForwardStatuses] = useState<Record<string, PortForwardStatus>>({});
  const [hostKeyPrompt, setHostKeyPrompt] = useState<SshHostKeyPrompt | null>(null);
  const [hostKeyPending, setHostKeyPending] = useState(false);
  const [hostKeyChangedAcknowledged, setHostKeyChangedAcknowledged] = useState(false);
  const [hostKeySecondsLeft, setHostKeySecondsLeft] = useState(HOST_KEY_PROMPT_TIMEOUT_SECS);
  const [followBottom, setFollowBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const ctrlActiveRef = useRef(false);
  const isRecordingRef = useRef(false);
  const followBottomRef = useRef(true);
  const activeRef = useRef(active);
  const recordingBufferRef = useRef<RecordingBufferState>(createRecordingBuffer());
  const recordingCapNotifiedRef = useRef(false);
  // Scrollback text captured before a reconnect so the re-run of the connection
  // effect (which disposes the old xterm) can replay it into the new terminal.
  const preservedScrollbackRef = useRef<string | null>(null);
  const termRef = useRef<XTermInstance | null>(null);
  const searchAddonRef = useRef<SearchAddonInstance | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toolMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);

  // Pop-out windows receive this bounded SSH-only settings snapshot from main.
  const sshSettings = preferences ?? getRuntimeSettings().ssh;
  const portForwardRules: PortForwardRule[] = sshSettings.portForwards;
  const startPortForward = useCallback(async (sid: string, rule: PortForwardRule) => {
    try {
      const localPort = await browserRuntime.startPortForward(sid, rule);
      setPortForwardStatuses((prev) => ({
        ...prev,
        [rule.id]: { ruleId: rule.id, active: true, localPort },
      }));
    } catch (error) {
      setPortForwardStatuses((prev) => ({
        ...prev,
        [rule.id]: {
          ruleId: rule.id,
          active: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, []);

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
    onStatusChangeRef.current(status, statusKind);
  }, [status, statusKind]);

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
      const settings = preferences ?? getRuntimeSettings().ssh;
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
    setClosedAt(null);
    // A new connection target must not inherit the previous host's output.
    preservedScrollbackRef.current = null;
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

    const sshTerminal = (preferences ?? getRuntimeSettings().ssh).terminal;

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
        convertEol: false,
        fontFamily: sshTerminal.fontFamily,
        fontSize: browserRuntime.isMobile ? Math.max(sshTerminal.fontSize, 15) : sshTerminal.fontSize,
        scrollback: sshTerminal.scrollback,
        theme: resolveTerminalTheme(sshTerminal.theme, sshTerminal.customColors),
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
          terminal.loadAddon(new WebLinksAddon((_event, url) => browserRuntime.openExternal(url)));
        } catch {
          // WebLinks addon not available
        }
      }
      try {
        const { SearchAddon } = await import("@xterm/addon-search");
        const searchAddon = new SearchAddon();
        terminal.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
        searchAddon.onDidChangeResults((results) => {
          setSearchStatus({ index: results.resultIndex, count: results.resultCount });
        });
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
      // The virtual mobile Ctrl modifier composes its control character in the
      // onData gate below. xterm's onKey has no return-value semantics, so a
      // composer there could not stop onData from also forwarding the raw
      // letter — the historical double-send bug.
      if (activeRef.current) terminal.focus();
      // Replay the previous session's scrollback (captured by handleReconnect)
      // so the reconnect does not destroy the only record of what happened.
      const preservedScrollback = preservedScrollbackRef.current;
      preservedScrollbackRef.current = null;
      if (preservedScrollback) {
        const historyLines = preservedScrollback.split("\r\n");
        for (let start = 0; start < historyLines.length; start += RECONNECT_REPLAY_CHUNK_ROWS) {
          if (disposed) return;
          terminal.write(historyLines.slice(start, start + RECONNECT_REPLAY_CHUNK_ROWS).join("\r\n") + "\r\n");
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        if (disposed) return;
        terminal.writeln(`\r\n── ${tt("以上为会话重连前的历史输出", "Preserved terminal history from previous session")} ──`);
      }
      terminal.writeln(tt("正在建立 SSH 连接...", "Establishing SSH connection..."));

      dataDisposable = terminal.onData((data) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        const composed = composeMobileControl(ctrlActiveRef.current, data);
        if (!composed.send) return;
        // Native write errors arrive as session events; closing also cancels queued input.
        void browserRuntime.writeSshSession(sessionId, composed.send).catch(() => {});
        if (composed.ctrlConsumed) {
          ctrlActiveRef.current = false;
          setCtrlActive(false);
        }
      });

      try {
        const activeTerminal = terminal;
        // The resolver is the single merge point: the request's own values win,
        // SSH settings fill the gaps, and the measured PTY size overrides both
        // (settings sizes are only a pre-fit fallback).
        const sessionId = await browserRuntime.openSshSession(
          resolveSshConnectionRequest(request, { cols: activeTerminal.cols, rows: activeTerminal.rows }),
        );
        if (disposed) {
          void browserRuntime.closeSshSession(sessionId);
          return;
        }
        sessionIdRef.current = sessionId;
        setSessionId(sessionId);
        let historyRecorded = false;
        unlisten = await browserRuntime.onSshSessionEvent(sessionId, (event) => {
          if (event.kind === "output" && event.data) {
            activeTerminal.write(event.data, () => {
              if (disposed || sessionIdRef.current !== sessionId) return;
              // Receiving an event is not consumption: release native credits
              // only after xterm has parsed the batch, including hidden tabs.
              if (event.outputSequence !== undefined) {
                void browserRuntime.acknowledgeSshOutput(sessionId, event.outputSequence).catch(() => {});
              }
              if (followBottomRef.current) {
                activeTerminal.scrollToBottom();
              } else {
                setHasNewOutput(true);
              }
            });
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
            setStatusKind(statusKindFromPhase(event.phase));
            activeTerminal.writeln(`\r\n${event.message}`);
            if (!historyRecorded && event.phase === "connected") {
              historyRecorded = true;
              void browserRuntime.addSshHistory(
                {
                  host: request.host,
                  port: request.port ?? "",
                  username: request.username ?? "",
                  taskName: request.taskName ?? "",
                },
                (preferences ?? getRuntimeSettings().ssh).maxHistoryEntries,
              );
            }
            return;
          }
          if (event.kind === "host-key-prompt" && event.data) {
            try {
              const payload = JSON.parse(event.data) as SshHostKeyPrompt;
              setHostKeyPrompt(payload);
              setHostKeyChangedAcknowledged(false);
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
            // The host-key prompt (or its 120s timeout) is superseded by the
            // failure; leaving the alertdialog open would strand the user.
            setHostKeyPrompt(null);
            return;
          }
          if (event.kind === "closed") {
            setStatus(event.message ?? tt("SSH 会话已关闭", "SSH session closed"));
            setStatusKind("closed");
            setClosedAt(formatClock(new Date()));
            setCanReconnect(true);
          }
        });
        // Listen for port-forward-status events to update the UI state.
        unlistenPf = await browserRuntime.onPortForwardStatus(sessionId, (pfStatus) => {
          setPortForwardStatuses((prev) => ({ ...prev, [pfStatus.ruleId]: pfStatus }));
        });
        // Auto-start enabled port forwarding rules from settings once
        // connected. Rules scoped to a host only start for that host so a
        // forward configured for one machine is not attempted everywhere.
        if (!disposed) {
          const enabledRules = (preferences ?? getRuntimeSettings().ssh).portForwards.filter(
            (rule) => rule.enabled && portForwardRuleAppliesToHost(rule, request.host),
          );
          for (const rule of enabledRules) {
            void startPortForward(sessionId, rule);
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
  }, [request, reconnectKey, startPortForward, tt, toast, preferences]);

  const sendKeySeq = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const composed = composeMobileControl(ctrlActiveRef.current, data);
    if (!composed.send) return;
    void browserRuntime.writeSshSession(sid, composed.send).catch(() => {});
    if (composed.ctrlConsumed) {
      ctrlActiveRef.current = false;
      setCtrlActive(false);
    }
  }, []);

  const handleSearch = useCallback((direction: "next" | "prev") => {
    const addon = searchAddonRef.current;
    if (!addon || !searchQuery) return;
    if (direction === "next") {
      addon.findNext(searchQuery, SSH_SEARCH_DECORATIONS);
    } else {
      addon.findPrevious(searchQuery, SSH_SEARCH_DECORATIONS);
    }
  }, [searchQuery]);

  const toggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else {
        setSearchQuery("");
        setSearchStatus(null);
        searchAddonRef.current?.clearDecorations?.();
        setTimeout(() => termRef.current?.focus(), 0);
      }
      return next;
    });
  }, []);

  const handleReconnect = () => {
    // Capture the scrollback before the reconnect re-runs the connection
    // effect and disposes the terminal that holds it.
    if (termRef.current) {
      preservedScrollbackRef.current = serializeTerminalBuffer(termRef.current);
    }
    setCanReconnect(false);
    setClosedAt(null);
    setReconnectKey((key) => key + 1);
  };

  const respondHostKey = (accept: boolean) => {
    if (hostKeyPending || !hostKeyPrompt) return;
    if (accept && hostKeyPrompt.requiresChangedConfirmation && !hostKeyChangedAcknowledged) return;
    const promptId = hostKeyPrompt.promptId;
    setHostKeyPending(true);
    void browserRuntime
      .confirmKnownHost(promptId, accept, hostKeyChangedAcknowledged)
      .catch(() => {})
      .finally(() => {
        setHostKeyPending(false);
        setHostKeyPrompt(null);
      });
  };

  // The native side rejects the host-key prompt after 120s; surface the
  // remaining time so the timeout does not fail as a surprise.
  useEffect(() => {
    if (!hostKeyPrompt) return;
    setHostKeySecondsLeft(HOST_KEY_PROMPT_TIMEOUT_SECS);
    const timer = window.setInterval(() => {
      setHostKeySecondsLeft((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hostKeyPrompt]);

  const statusColorClass =
    statusKind === "connected"
      ? "text-app-success"
      : statusKind === "failed"
        ? "text-app-danger"
        : statusKind === "closed"
          ? "text-app-warning"
          : "text-app-terminalMuted";

  const closeToolMenu = useCallback(() => {
    setShowToolMenu(false);
    window.setTimeout(() => toolMenuTriggerRef.current?.focus(), 0);
  }, []);

  // Escape closes the tool menu no matter where focus sits: the trigger button
  // lives outside the overlay, so an overlay-level handler would miss it.
  const toolMenuLayerRef = useOverlay(showToolMenu, "popover");
  useEffect(() => {
    if (!showToolMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && claimOverlayKey(toolMenuLayerRef.current, event)) {
        event.preventDefault();
        event.stopPropagation();
        closeToolMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showToolMenu, closeToolMenu, toolMenuLayerRef]);

  useMobileBackLayer(showToolMenu, closeToolMenu);

  return (
    <div
      id={`ssh-terminal-panel-${tabId}`}
      className={cn("app-terminal-chrome relative flex h-full flex-col", !active && "hidden")}
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
              "flex h-6 w-6 items-center justify-center rounded",
              showSearch ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
            )}
            type="button"
            title={text("搜索 (Ctrl+F)", "Search (Ctrl+F)")}
            aria-label={text("搜索 (Ctrl+F)", "Search (Ctrl+F)")}
            aria-pressed={showSearch}
            onClick={toggleSearch}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded",
              isRecording ? "text-app-danger hover:bg-app-terminalBg" : "text-app-terminalText hover:bg-app-terminalBg",
            )}
            type="button"
            title={isRecording ? text("停止录制", "Stop recording") : text("录制", "Record")}
            aria-label={text("录制", "Record")}
            aria-pressed={isRecording}
            onClick={toggleRecording}
          >
            {isRecording ? <Square className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
          </button>
          {browserRuntime.supportsInAppSsh ? (
            <button
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded",
                showSftp ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={sessionId ? sftpLabel : disconnectedHint}
              aria-label={sessionId ? sftpLabel : disconnectedHint}
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
                "flex h-6 w-6 items-center justify-center rounded",
                showPortForward ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={sessionId ? portForwardsLabel : disconnectedHint}
              aria-label={sessionId ? portForwardsLabel : disconnectedHint}
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
                "flex h-11 w-11 items-center justify-center rounded md:hidden",
                showSftp ? "bg-app-terminalBg text-app-terminalAccent" : "text-app-terminalText hover:bg-app-terminalBg",
              )}
              type="button"
              title={sessionId ? sftpLabel : disconnectedHint}
              aria-label={sessionId ? sftpLabel : disconnectedHint}
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
            className="flex h-11 w-11 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg md:hidden"
            type="button"
            title={text("更多终端工具", "More terminal tools")}
            aria-label={text("更多终端工具", "More terminal tools")}
            aria-haspopup="menu"
            aria-expanded={showToolMenu}
            aria-controls={`ssh-terminal-tools-${tabId}`}
            onClick={() => {
              if (showToolMenu) {
                closeToolMenu();
              } else {
                setShowToolMenu(true);
                // Move focus into the menu so keyboard users start on an item
                // instead of being left behind on the trigger.
                window.setTimeout(() => toolMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(), 0);
              }
            }}
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {isRecording ? (
            <span className="hidden items-center gap-1 text-xs text-app-danger md:flex">
              <Circle className="h-2 w-2 animate-pulse fill-current" />
              {text("录制中", "Recording")}
            </span>
          ) : null}
          <span className={cn("hidden shrink-0 items-center gap-1 md:inline-flex", statusColorClass)} aria-live="polite">
            {statusKind === "closed" ? <Unplug className="h-3 w-3 shrink-0" /> : null}
            <span className="max-w-48 truncate" title={status}>
              {status}
            </span>
            {statusKind === "closed" && closedAt ? <span className="shrink-0 text-app-terminalMuted">· {closedAt}</span> : null}
          </span>
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full md:hidden",
              statusKind === "connected" ? "bg-app-success" : statusKind === "failed" ? "bg-app-danger" : statusKind === "closed" ? "bg-app-warning" : "bg-app-terminalMuted",
            )}
            aria-label={status}
          />
        </div>
      </div>
      {showToolMenu ? (
        <div
          className="app-scrim absolute inset-0 z-30 flex items-end md:hidden"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeToolMenu();
          }}
        >
          <div ref={toolMenuRef} id={`ssh-terminal-tools-${tabId}`} className="w-full rounded-t-lg border border-b-0 border-app-terminalBorder bg-app-terminalPanel p-2 shadow-popover" role="menu" aria-label={text("终端工具", "Terminal tools")}>
            <button
              className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg"
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
              className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg"
              type="button"
              role="menuitem"
              onClick={() => {
                toggleRecording();
                closeToolMenu();
              }}
            >
              {isRecording ? <Square className="h-4 w-4 text-app-danger" /> : <Circle className="h-4 w-4" />}
              {isRecording ? text("停止录制", "Stop recording") : text("录制", "Record")}
            </button>
            {browserRuntime.supportsInAppSsh ? (
              <button
                className="flex min-h-11 w-full items-center gap-3 rounded px-3 text-left text-sm text-app-terminalText hover:bg-app-terminalBg disabled:opacity-40"
                type="button"
                role="menuitem"
                title={sessionId ? undefined : disconnectedHint}
                aria-expanded={showPortForward}
                aria-controls={`ssh-port-forward-panel-${tabId}`}
                disabled={!sessionId}
                onClick={() => {
                  setShowPortForward((open) => !open);
                  closeToolMenu();
                }}
              >
                <Network className="h-4 w-4" />
                {portForwardsLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {showSearch ? (
        <div className="flex h-9 items-center gap-1.5 border-b border-app-terminalBorder bg-app-terminalPanel px-3">
          <input
            ref={searchInputRef}
            className="h-6 min-w-0 flex-1 rounded border border-app-terminalBorder bg-app-terminalBg px-2 text-xs text-app-terminalText placeholder:text-app-terminalMuted"
            type="text"
            placeholder={text("搜索...", "Search...")}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchStatus(null);
            }}
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
          {searchQuery && searchStatus ? (
            <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-app-terminalMuted" aria-live="polite">
              {searchStatus.count === 0
                ? text("无匹配", "No matches")
                : searchStatus.index >= 0
                  ? `${searchStatus.index + 1}/${searchStatus.count}`
                  : `${searchStatus.count}+`}
            </span>
          ) : null}
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg"
            type="button"
            title={text("上一个", "Previous")}
            aria-label={text("上一个", "Previous")}
            onClick={() => handleSearch("prev")}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg"
            type="button"
            title={text("下一个", "Next")}
            aria-label={text("下一个", "Next")}
            onClick={() => handleSearch("next")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg"
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
              className="absolute bottom-3 right-3 z-10 rounded-md bg-app-accent px-2.5 py-1.5 text-xs font-medium text-app-onAccent shadow-shell hover:opacity-90"
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
            aria-label={sftpLabel}
          >
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-app-terminalBorder px-3 text-xs text-app-terminalText md:hidden">
              <span className="font-medium">{sftpLabel}</span>
              <button
                className="flex h-8 w-8 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg"
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
            aria-label={portForwardsLabel}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium">{portForwardsLabel}</span>
              <button
                className="flex h-11 w-11 items-center justify-center rounded text-app-terminalText hover:bg-app-terminalBg md:h-5 md:w-5"
                type="button"
                title={text("关闭", "Close")}
                aria-label={text("关闭", "Close")}
                onClick={() => setShowPortForward(false)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {portForwardRules.length === 0 ? (
              <div className="py-4 text-center text-app-terminalMuted">
                {text("暂无端口转发规则，可在设置中添加。", "No port-forward rules yet. Add them in Settings.")}
              </div>
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
                              {rule.localHost}:{active ? (status.localPort ?? rule.localPort) : rule.localPort === 0 ? text("自动", "Auto") : rule.localPort}
                              {rule.type !== "dynamic" ? ` → ${rule.remoteHost}:${rule.remotePort}` : ""}
                            </span>
                            {rule.host ? (
                              <span
                                className="shrink-0 rounded bg-app-terminalPanel px-1 py-0.5 text-app-terminalMuted"
                                title={text("仅对该主机会话自动启动", "Auto-starts for this host's sessions only")}
                              >
                                @{rule.host}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-xs text-app-terminalMuted">
                            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", active ? "bg-app-success" : "bg-app-terminalMuted")} />
                            {active ? text("运行中", "Active") : text("已停止", "Inactive")}
                          </div>
                          {status?.error ? (
                            <div className="mt-1 break-all text-xs text-app-danger">{status.error}</div>
                          ) : null}
                        </div>
                        <button
                          className="shrink-0 rounded bg-app-terminalPanel px-2 py-1 text-xs text-app-terminalText hover:bg-app-terminalBorder"
                          type="button"
                          disabled={!sessionId}
                          onClick={() => {
                            if (!sessionId) return;
                            if (active) {
                              void browserRuntime.stopPortForward(sessionId, rule.id).catch(() => {});
                            } else {
                              void startPortForward(sessionId, rule);
                            }
                          }}
                        >
                          {active ? text("停止", "Stop") : text("启动", "Start")}
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
                  "flex h-8 min-w-9 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px]",
                  isCtrl && ctrlActive
                    ? "bg-app-accent text-app-onAccent"
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
                    const sequences: Record<string, string> = {
                      "Esc": "\x1b",
                      "Tab": "\x09",
                      "↑": "\x1b[A",
                      "↓": "\x1b[B",
                      "←": "\x1b[D",
                      "→": "\x1b[C",
                    };
                    const seq = sequences[label];
                    if (seq) sendKeySeq(seq);
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
                className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg"
                type="button"
                onPointerDown={(event) => {
                  event.preventDefault();
                  const sid = sessionIdRef.current;
                  if (sid) void browserRuntime.writeSshSession(sid, String.fromCharCode(charCode)).catch(() => {});
                  setTimeout(() => termRef.current?.focus(), 0);
                }}
              >
                {combo}
              </button>
            );
          })}
          <div className="mx-0.5 h-5 w-px shrink-0 bg-app-terminalBorder" />
          <button
            className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg"
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
            className="flex h-8 shrink-0 items-center justify-center rounded px-2 font-mono text-[11px] text-app-terminalText hover:bg-app-terminalBg"
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
          className="app-scrim absolute inset-0 z-20 flex items-center justify-center p-4"
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
          <div className="w-full max-w-md space-y-4 rounded-lg border border-app-border bg-app-elevated p-4 text-sm shadow-popover">
            <div>
              <h3 id={`ssh-host-key-title-${tabId}`} className="text-sm font-semibold text-app-text">
                {text("确认 SSH 主机密钥", "Confirm SSH Host Key")}
              </h3>
              <p className="mt-2 leading-6 text-app-muted">
                {hostKeyPrompt.changedKey
                  ? hostKeyPrompt.taskChanged
                    ? text(
                        "此地址对应的任务 ID 已变化，可能是实例回收后重新分配。请核对新旧指纹，并确认这是预期的新实例。",
                        "The task ID for this address changed, which may indicate a recycled instance. Compare both fingerprints and confirm this new assignment is expected.",
                      )
                    : text(
                        "主机密钥与已信任记录不同。只有在已通过可信渠道核实变更后才继续。",
                        "The host key differs from the trusted record. Continue only after verifying the change through a trusted channel.",
                      )
                  : text(
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
                <span className="text-app-muted">{hostKeyPrompt.changedKey ? text("新指纹", "New fingerprint") : "Fingerprint"}</span>
                <div className="mt-0.5 break-all text-app-text">{hostKeyPrompt.fingerprint}</div>
              </div>
              {hostKeyPrompt.previousFingerprint ? (
                <div>
                  <span className="text-app-muted">{text("已信任的指纹", "Trusted fingerprint")}</span>
                  <div className="mt-0.5 break-all text-app-text">{hostKeyPrompt.previousFingerprint}</div>
                </div>
              ) : null}
              {hostKeyPrompt.changedKey ? (
                <div className="grid grid-cols-2 gap-2 border-t border-app-border pt-2">
                  <div>
                    <span className="text-app-muted">{text("旧任务 ID", "Previous task ID")}</span>
                    <div className="mt-0.5 break-all text-app-text">{hostKeyPrompt.previousTaskId || text("未知", "Unknown")}</div>
                  </div>
                  <div>
                    <span className="text-app-muted">{text("当前任务 ID", "Current task ID")}</span>
                    <div className="mt-0.5 break-all text-app-text">{hostKeyPrompt.taskId || text("未知", "Unknown")}</div>
                  </div>
                </div>
              ) : null}
            </div>
            {hostKeyPrompt.requiresChangedConfirmation ? (
              <label className="flex items-start gap-2 text-xs leading-5 text-app-text">
                <input
                  className="mt-1 accent-app-accent"
                  type="checkbox"
                  checked={hostKeyChangedAcknowledged}
                  onChange={(event) => setHostKeyChangedAcknowledged(event.target.checked)}
                />
                <span>{text("我已通过可信渠道核实新主机指纹，并接受替换原有信任记录。", "I verified the new host fingerprint through a trusted channel and accept replacing the existing trust record.")}</span>
              </label>
            ) : null}
            <p className="text-xs text-app-muted">
              {text(
                `未确认将在 ${hostKeySecondsLeft} 秒后自动拒绝并断开连接。`,
                `Without confirmation the connection is rejected automatically in ${hostKeySecondsLeft}s.`,
              )}
            </p>
            <div className="flex flex-col-reverse gap-2 border-t border-app-border pt-3 sm:flex-row sm:justify-end">
              <Button disabled={hostKeyPending} type="button" variant="secondary" autoFocus onClick={() => respondHostKey(false)}>
                {text("拒绝", "Reject")}
              </Button>
              <Button disabled={hostKeyPending || Boolean(hostKeyPrompt.requiresChangedConfirmation && !hostKeyChangedAcknowledged)} type="button" onClick={() => respondHostKey(true)}>
                {hostKeyPending ? text("提交中", "Submitting") : text("信任并继续", "Trust and continue")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
