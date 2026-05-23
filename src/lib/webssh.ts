import { getRuntimeSettings } from "./app-settings";

export function deriveWebsshUrl(taskId: string | number, cols: number, rows: number, apiBase = getRuntimeSettings().apiBaseUrl) {
  const apiUrl = new URL(apiBase, window.location.origin);
  const protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    task_id: String(taskId),
    cols: String(cols),
    rows: String(rows),
  });
  return `${protocol}//${apiUrl.host}/ws/webssh?${params.toString()}`;
}

export function formatTerminalInput(data: string) {
  return JSON.stringify({ status: 0, data }).replace(/\\\\/, "\\");
}

export function formatTerminalResize(cols: number, rows: number) {
  return JSON.stringify({ status: 1, cols, rows });
}
