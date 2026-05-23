import type { SshConnectionRequest, Task, UnknownRecord } from "./types";

const DEFAULT_SSH_USERNAME = "ubuntu";

export type TaskSshInfo = {
  host: string;
  port: string;
  username: string;
  password: string;
  command: string;
  taskId: string;
  taskName: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text && text !== "None") return text;
  }
  return "";
}

function nestedUserName(task: Task) {
  const user = task.user;
  if (!isRecord(user)) return "";
  return firstText(user.username, user.name);
}

function sshCommand(host: string, port: string, username: string) {
  if (!host || host === "-") return "-";
  const login = username && username !== "-" ? `${username}@${host}` : host;
  return port && port !== "-" ? `ssh -p ${port} ${login}` : `ssh ${login}`;
}

export function getTaskSshId(task: Task) {
  return task.task_id ?? task.id;
}

function getTaskLinkName(task: Task) {
  return firstText(task.name, task.task_name, task.description, getTaskSshId(task));
}

export function buildTaskSshInfo(task: Task): TaskSshInfo {
  const host = firstText(task.ssh_host, task.host, task.hostname, task.ip) || "-";
  const port = firstText(task.ssh_port, task.port) || "-";
  const username = firstText(task.ssh_username, task.ssh_user, task.login_user, DEFAULT_SSH_USERNAME);
  const password = firstText(task.ssh_password, task.password, nestedUserName(task)) || "-";

  return {
    host,
    port,
    username,
    password,
    command: sshCommand(host, port, username),
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
