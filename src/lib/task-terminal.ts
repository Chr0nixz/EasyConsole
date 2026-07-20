import { buildTaskSshInfo, toSshConnectionRequest, type TaskSshInfo } from "./ssh-info";
import type { SshConnectionRequest, Task } from "./types";

export type TaskTerminalAction =
  | { type: "app-ssh"; request: SshConnectionRequest; info: TaskSshInfo }
  | { type: "ssh-info"; info: TaskSshInfo };

export function canConnectTaskSsh(info: TaskSshInfo) {
  return info.host !== "-" && info.command !== "-";
}

export function resolveTaskTerminalAction(
  task: Task,
  options: { loginUsername?: string; supportsInAppSsh: boolean },
): TaskTerminalAction {
  const info = buildTaskSshInfo(task, { loginUsername: options.loginUsername });
  if (options.supportsInAppSsh && canConnectTaskSsh(info)) {
    return { type: "app-ssh", request: toSshConnectionRequest(info), info };
  }
  return { type: "ssh-info", info };
}

/** True when the primary terminal control will open an in-app SSH session. */
export function willOpenAppSshSession(
  task: Task,
  options: { loginUsername?: string; supportsInAppSsh: boolean },
) {
  return resolveTaskTerminalAction(task, options).type === "app-ssh";
}
