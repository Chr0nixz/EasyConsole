import { i18nText } from "./i18n-text";
import { buildTaskSshInfo, toSshConnectionRequest, type TaskSshInfo } from "./ssh-info";
import type { SshConnectionRequest, Task } from "./types";

export type TaskAccess = {
  terminal: boolean;
  /** Why the terminal is not offered; undefined when it is. */
  terminalReason?: string;
  log: boolean;
  logReason?: string;
};

/**
 * Whether the terminal and the log are offered for an instance, with the reason when not.
 * One rule for the table row, mobile card, More menu, command palette and the t / l keys:
 * only a running instance has a host to connect to (the original console gates 连接 the
 * same way), and initializing or queued instances have no log yet.
 */
export function getTaskAccess(task: Pick<Task, "status">): TaskAccess {
  const status = Number(task.status);
  const notStarted = status === 0 || status === 1;
  const notStartedReason = i18nText("实例尚未启动，启动后可用", "Available once the instance starts");
  return {
    terminal: status === 2,
    terminalReason: status === 2
      ? undefined
      : notStarted
        ? notStartedReason
        : status === 3
          ? i18nText("实例已暂停，无法连接", "The instance is paused; nothing to connect to")
          : i18nText("实例已结束，无法连接", "The instance has ended; nothing to connect to"),
    log: !notStarted,
    logReason: notStarted ? notStartedReason : undefined,
  };
}

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

/** True when in-app SSH can be started for this task from the connection-info drawer. */
export function willOpenAppSshSession(
  task: Task,
  options: { loginUsername?: string; supportsInAppSsh: boolean },
) {
  return resolveTaskTerminalAction(task, options).type === "app-ssh";
}
