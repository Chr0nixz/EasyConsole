import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useId, useState } from "react";

import { SshTerminalTab } from "../components/tasks/SshTerminalTab";
import type { SshTerminalPreferences } from "../lib/app-settings";
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
 * A URL hash fallback (`#/ssh-terminal?data=<json>`) exists only outside
 * Tauri, where no pending-request channel is available; it refuses requests
 * that carry a password so credentials can never travel through a URL, and
 * the Tauri runtime never parses the URL at all.
 */
/**
 * Parses the non-Tauri URL fallback (`#/ssh-terminal?data=<json>`). URL search
 * params are recorded in history and diagnostics, so a password in `data` is
 * rejected outright and the password field is stripped even from requests
 * without one. Runs once during the first render — never from an effect.
 */
function parseUrlSshRequest(
  text: (zh: string, en: string) => string,
): { request: SshConnectionRequest; error: null } | { request: null; error: string } | null {
  const hash = window.location.hash;
  const queryIdx = hash.indexOf("?");
  if (queryIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(queryIdx + 1));
  const raw = params.get("data");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SshConnectionRequest;
    if (!parsed.host) {
      return { request: null, error: text("连接参数无效", "Invalid connection parameters") };
    }
    if (parsed.password) {
      return {
        request: null,
        error: text("出于安全考虑，不接受通过 URL 传递密码", "For security reasons, passwords passed through the URL are not accepted"),
      };
    }
    // Strip the (absent) password field defensively: a URL-sourced request
    // must never carry credential-shaped data at all.
    const rest = { ...parsed };
    delete rest.password;
    return { request: rest, error: null };
  } catch {
    return { request: null, error: text("连接参数解析失败", "Failed to parse connection parameters") };
  }
}

export function SshTerminalPage() {
  const { text } = useI18n();
  // The URL fallback resolves during the first render (non-Tauri only); the
  // Tauri path fetches the pending request asynchronously in the effect below.
  const [urlSource] = useState(() => (isTauri() ? null : parseUrlSshRequest(text)));
  const [request, setRequest] = useState<SshConnectionRequest | null>(
    () => urlSource?.request ?? null,
  );
  const [error, setError] = useState<string | null>(() => urlSource?.error ?? null);
  const [preferences, setPreferences] = useState<SshTerminalPreferences>();

  useEffect(() => {
    let disposed = false;

    // Pull the request from Rust state by window label. The main window's
    // `open_ssh_window` call stashed it there before creating this window.
    if (isTauri()) {
      const label = getCurrentWindow().label;
      invoke<{ request: SshConnectionRequest; preferences: SshTerminalPreferences } | null>("get_ssh_window_request", { label })
        .then((result) => {
          if (disposed || !result) return;
          if (!result.request?.host || !result.preferences) {
            setError(text("连接参数无效", "Invalid connection parameters"));
            return;
          }
          setRequest(result.request);
          setPreferences(result.preferences);
        })
        .catch(() => {
          if (!disposed) setError(text("连接参数获取失败", "Failed to fetch connection parameters"));
        });
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
      <div className="flex h-full items-center justify-center bg-app-terminalBg text-app-terminalText">
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
      <div className="flex h-full items-center justify-center bg-app-terminalBg text-app-terminalText">
        <p className="text-sm text-app-terminalMuted">{text("正在初始化...", "Initializing...")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-app-terminalBg">
      <SshTerminalTab
        request={request}
        tabId={tabId}
        active={true}
        preferences={preferences}
        onStatusChange={() => {}}
      />
    </div>
  );
}
