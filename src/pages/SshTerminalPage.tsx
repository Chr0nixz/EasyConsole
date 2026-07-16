import { useEffect, useId, useState } from "react";

import { SshTerminalTab } from "../components/tasks/SshTerminalTab";
import { useI18n } from "../lib/i18n";
import type { SshConnectionRequest } from "../lib/types";

/**
 * Standalone SSH terminal page rendered in a popped-out Tauri window.
 * The connection request is passed via URL hash query param `data`
 * (percent-encoded JSON) by the Rust `open_ssh_window` command.
 */
export function SshTerminalPage() {
  const { text } = useI18n();
  const [request, setRequest] = useState<SshConnectionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Parse the connection request from the URL hash query string.
  // URL format: #/ssh-terminal?data=<percent-encoded-json>
  useEffect(() => {
    const hash = window.location.hash;
    const queryIdx = hash.indexOf("?");
    if (queryIdx === -1) {
      setError(text("缺少连接参数", "Missing connection parameters"));
      return;
    }
    const params = new URLSearchParams(hash.slice(queryIdx + 1));
    const raw = params.get("data");
    if (!raw) {
      setError(text("缺少连接参数", "Missing connection parameters"));
      return;
    }
    try {
      const parsed = JSON.parse(raw) as SshConnectionRequest;
      if (!parsed.host) {
        setError(text("连接参数无效", "Invalid connection parameters"));
        return;
      }
      setRequest(parsed);
    } catch {
      setError(text("连接参数解析失败", "Failed to parse connection parameters"));
    }
  }, [text]);

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
