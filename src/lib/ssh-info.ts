import type { SshConnectionRequest, Task } from "./types";
import { getRuntimeSettings } from "./app-settings";
import { i18nText } from "./i18n-text";

const FALLBACK_SSH_USERNAME = "ubuntu";

export type TaskSshInfo = {
  host: string;
  port: string;
  username: string;
  password: string;
  /** Where the password value came from, so the UI can copy/label it honestly. */
  passwordKind: TaskSshPasswordKind;
  command: string;
  taskId: string;
  taskName: string;
};

export type TaskSshPasswordKind = "returned" | "settings-default" | "login-username" | "none";

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text && text !== "None") return text;
  }
  return "";
}

const SSH_HOST_PATTERN = /^[\w.:[\]-]+$/;
const SSH_USERNAME_PATTERN = /^[\w.-]+$/;

/**
 * Quotes one shell word for the copyable command text. Host/username/port that
 * pass the allowlists above never need quoting, so this only fires if those
 * allowlists are ever loosened — it is defense in depth, not the gate.
 */
export function quoteSshArg(arg: string) {
  return SSH_HOST_PATTERN.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export type SshCommandInput = {
  host: string;
  port?: string;
  username?: string;
};

/**
 * Renders the copyable `ssh …` command from validated parts, or null when any
 * part is missing or fails validation — copied text must never contain
 * unvalidated API fields, so callers treat null as "no command available".
 */
export function formatSshCommand(input: SshCommandInput): string | null {
  const host = input.host.trim();
  if (!host || host === "-") return null;
  if (!SSH_HOST_PATTERN.test(host)) return null;
  const username = input.username?.trim();
  if (username && username !== "-" && !SSH_USERNAME_PATTERN.test(username)) return null;
  const port = input.port?.trim();
  if (port && port !== "-" && findSshPortIssue(port)) return null;
  const login =
    username && username !== "-"
      ? `${quoteSshArg(username)}@${quoteSshArg(host)}`
      : quoteSshArg(host);
  return port && port !== "-" ? `ssh -p ${quoteSshArg(port)} ${login}` : `ssh ${login}`;
}

export function getTaskSshId(task: Task) {
  return task.task_id ?? task.id;
}

function getTaskLinkName(task: Task) {
  return firstText(task.name, task.task_name, task.description, getTaskSshId(task));
}

export type BuildTaskSshInfoOptions = {
  /** Console login username; used as SSH password when the API omits one. */
  loginUsername?: string;
};

export function buildTaskSshInfo(task: Task, options?: BuildTaskSshInfoOptions): TaskSshInfo {
  const defaultUsername = getRuntimeSettings().ssh.defaultUsername || FALLBACK_SSH_USERNAME;
  const host = firstText(task.ssh_host, task.host, task.hostname, task.ip) || "-";
  const port = firstText(task.ssh_port, task.port) || "-";
  const username = firstText(task.ssh_username, task.ssh_user, task.login_user, defaultUsername);
  // Platform instances use settings defaultPassword, then console login username.
  const defaultPassword = getRuntimeSettings().ssh.defaultPassword;
  const taskPassword = firstText(task.ssh_password, task.password);
  const settingsPassword = firstText(defaultPassword);
  const loginNamePassword = firstText(options?.loginUsername);
  const password = taskPassword || settingsPassword || loginNamePassword || "-";
  const passwordKind: TaskSshPasswordKind = taskPassword
    ? "returned"
    : settingsPassword
      ? "settings-default"
      : loginNamePassword
        ? "login-username"
        : "none";

  return {
    host,
    port,
    username,
    password,
    passwordKind,
    command: formatSshCommand({ host, port, username }) ?? "-",
    taskId: String(getTaskSshId(task)),
    taskName: getTaskLinkName(task),
  };
}

export function toSshConnectionRequest(info: TaskSshInfo): SshConnectionRequest {
  return {
    host: info.host === "-" ? "" : info.host,
    port: info.port === "-" ? undefined : info.port,
    username: info.username === "-" ? undefined : info.username,
    password: info.password === "-" ? undefined : info.password,
    command: info.command,
    taskId: info.taskId,
    taskName: info.taskName,
  };
}

export type ResolvedSshConnectionOptions = {
  /** Measured PTY size from the terminal's fit result; settings defaults are the fallback. */
  cols?: number;
  rows?: number;
};

/**
 * Single normalization point shared by every SSH entry — task rows, manually
 * added tabs, popped-out windows, the system terminal, and VS Code. Values the
 * user or task provided win; SSH settings only fill gaps, so the same target
 * resolves identically no matter which entry opened it. `keepaliveIntervalSec
 * === 0` means "disabled" and is passed through for the native side to map to
 * no keepalive timer (never a zero-second interval).
 */
export function resolveSshConnectionRequest(
  input: SshConnectionRequest,
  options?: ResolvedSshConnectionOptions,
): SshConnectionRequest {
  const ssh = getRuntimeSettings().ssh;
  const port = normalizeSshPort(input.port) ?? String(ssh.defaultPort);
  const username = input.username?.trim() || ssh.defaultUsername || undefined;
  return {
    ...input,
    host: input.host.trim(),
    port,
    username,
    password: input.password?.trim() || undefined,
    cols: Math.max(1, Math.trunc(options?.cols ?? input.cols ?? ssh.defaultCols)),
    rows: Math.max(1, Math.trunc(options?.rows ?? input.rows ?? ssh.defaultRows)),
    connectTimeoutSec: input.connectTimeoutSec ?? ssh.connectTimeoutSec,
    keepaliveIntervalSec: input.keepaliveIntervalSec ?? ssh.keepaliveIntervalSec,
    termType: input.termType ?? ssh.termType,
    sshKeyPath: input.sshKeyPath?.trim() || ssh.sshKeyPath || undefined,
    authMode: input.authMode ?? ssh.authMode,
  };
}

/** Treats "-", "" and whitespace-only ports as "unset" so settings can fill them in. */
function normalizeSshPort(port: string | undefined): string | undefined {
  const trimmed = port?.trim();
  if (!trimmed || trimmed === "-") return undefined;
  return trimmed;
}

function findSshPortIssue(port: string): string | null {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return i18nText("SSH 端口必须在 1-65535 之间", "The SSH port must be between 1 and 65535");
  }
  return null;
}

/**
 * Pre-flight validation mirroring the native checks, so clearly malformed
 * input fails at the entry point with an actionable message instead of as a
 * raw connection error after an IPC round-trip.
 */
export function findSshConnectionIssue(request: SshConnectionRequest): string | null {
  if (!request.host.trim()) {
    return i18nText("SSH 主机地址为空", "SSH host is empty");
  }
  if (!SSH_HOST_PATTERN.test(request.host.trim())) {
    return i18nText("SSH 主机地址包含不支持的字符", "SSH host contains unsupported characters");
  }
  if (request.port !== undefined) {
    const portIssue = findSshPortIssue(request.port);
    if (portIssue) return portIssue;
  }
  if (request.username) {
    if (!SSH_USERNAME_PATTERN.test(request.username.trim())) {
      return i18nText("SSH 用户名包含不支持的字符", "SSH username contains unsupported characters");
    }
  }
  return null;
}
