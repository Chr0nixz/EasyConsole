import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useId, useState } from "react";

import { SshTerminalTab } from "../components/tasks/SshTerminalTab";
import { useI18n } from "../lib/i18n";
import type { SshConnectionRequest } from "../lib/types";

/**
 * Standalone SSH terminal page rendered in a popped-out Tauri window.
 *
 * The connection request is pulled from the Rust `PendingSshWindows` state
 * (keyed by this window's label) via the `get_ssh_window_request` command.
 * This avoids fragile URL hash encoding/decoding (especially around `?`
 * inside hash fragments), keeps `password` out of the URL, and sidesteps
 * the event-timing race where Tauri emits before the frontend `listen`
 * has registered.
 *
 * A URL hash fallback (`#/ssh-terminal?data=<json>`) is kept for non-Tauri
 * runtimes or manual deep-linking scenarios.
 */
export function SshTerminalPage() {
  const { text } = useI18n();
  const [request, setRequest] = useState<SshConnectionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    // Primary path: pull the request from Rust state by window label.
    // The main window's `open_ssh_window` call stashed it there before
    // creating this window.
    const label = isTauri() ? getCurrentWindow().label : "";
    if (label) {
      invoke<SshConnectionRequest | null>("get_ssh_window_request", { label })
        .then((result) => {
          if (disposed) return;
          if (!result) {
            // No pending request for this label — fall through to URL hash
            // parsing below before surfacing an error.
            return;
          }
          if (!result.host) {
            setError(text("连接参数无效", "Invalid connection parameters"));
            return;
          }
          setRequest(result);
        })
        .catch(() => {
          // Fall through to URL hash parsing below.
        });
    }

    // Fallback: parse the connection request from the URL hash query string.
    // URL format: #/ssh-terminal?data=<json>
    const hash = window.location.hash;
    const queryIdx = hash.indexOf("?");
    if (queryIdx !== -1) {
      const params = new URLSearchParams(hash.slice(queryIdx + 1));
      const raw = params.get("data");
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as SshConnectionRequest;
          if (!parsed.host) {
            setError(text("连接参数无效", "Invalid connection parameters"));
          } else {
            setRequest(parsed);
          }
        } catch {
          setError(text("连接参数解析失败", "Failed to parse connection parameters"));
        }
      }
    }

    return () => {
      disposed = true;
    };
  }, [text]);

  // If neither the command nor the URL hash produced a request within 6s,
  // surface a visible error instead of hanging on the loading state.
  useEffect(() => {
    if (request || error) return;
    const timer = window.setTimeout(() => {
      setError((prev) => prev ?? text("缺少连接参数", "Missing connection parameters"));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [request, error, text]);

  const tabId = useId();

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-app-terminalBg text-app-terminalText">
        <div className="text-center">
          <p className="text-sm">{error}</p>
          <button
            className="mt-4 rounded-md bg-app-panel px-4 py-2 text-xs hover:bg-app-surface"
            type="button"
            onClick={() => window.close()}
          >
            {text("关闭窗口", "Close window")}
          </button>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="flex h-screen items-center justify-center bg-app-terminalBg text-app-terminalText">
        <p className="text-sm text-app-terminalMuted">{text("正在初始化...", "Initializing...")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-app-terminalBg">
      <SshTerminalTab
        request={request}
        tabId={tabId}
        active={true}
        onStatusChange={() => {}}
      />
    </div>
  );
}
