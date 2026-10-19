import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS, getRuntimeSettings, setRuntimeSettings } from "./app-settings";
import {
  buildTaskSshInfo,
  findSshConnectionIssue,
  formatSshCommand,
  getTaskSshId,
  quoteSshArg,
  resolveSshConnectionRequest,
  toSshConnectionRequest,
} from "./ssh-info";
import type { Task } from "./types";

describe("ssh info", () => {
  beforeEach(() => {
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
  });
  it("builds SSH info from original console task fields", () => {
    const task = {
      id: 1,
      task_id: "task-1",
      name: "demo",
      ip: "10.0.0.8",
      port: 30222,
      user: { username: "alice" },
    } satisfies Task;

    expect(buildTaskSshInfo(task)).toMatchObject({
      host: "10.0.0.8",
      port: "30222",
      username: "ubuntu",
      password: "-",
      passwordKind: "none",
      command: "ssh -p 30222 ubuntu@10.0.0.8",
    });
  });

  it("prefers task_id for SSH launch requests", () => {
    expect(getTaskSshId({ id: 1, task_id: "task-1" })).toBe("task-1");
  });

  it("builds a desktop launch request without placeholder values", () => {
    const info = buildTaskSshInfo({
      id: 1,
      task_id: "task-1",
      name: "demo",
      ip: "10.0.0.8",
      port: 30222,
      user: { username: "alice" },
    });

    expect(toSshConnectionRequest(info)).toEqual({
      host: "10.0.0.8",
      port: "30222",
      username: "ubuntu",
      password: undefined,
      command: "ssh -p 30222 ubuntu@10.0.0.8",
      taskId: "task-1",
      taskName: "demo",
    });
  });

  it("defaults SSH password to the login username when API omits it", () => {
    const info = buildTaskSshInfo(
      {
        id: 1,
        task_id: "task-1",
        name: "demo",
        ip: "10.0.0.8",
        port: 30222,
      },
      { loginUsername: "alice" },
    );

    expect(info.password).toBe("alice");
    expect(info.passwordKind).toBe("login-username");
    expect(toSshConnectionRequest(info).password).toBe("alice");
  });

  it("prefers settings defaultPassword over login username", () => {
    setRuntimeSettings({
      ssh: {
        ...getRuntimeSettings().ssh,
        defaultPassword: "from-settings",
      },
    });

    const info = buildTaskSshInfo(
      {
        id: 1,
        task_id: "task-1",
        name: "demo",
        ip: "10.0.0.8",
        port: 30222,
      },
      { loginUsername: "alice" },
    );

    expect(info.password).toBe("from-settings");
    expect(info.passwordKind).toBe("settings-default");
  });

  it("uses explicit SSH password fields when present", () => {
    const info = buildTaskSshInfo(
      {
        id: 1,
        task_id: "task-1",
        name: "demo",
        ip: "10.0.0.8",
        port: 30222,
        ssh_password: "secret",
        user: { username: "alice" },
      },
      { loginUsername: "alice" },
    );

    expect(info.password).toBe("secret");
    expect(info.passwordKind).toBe("returned");
    expect(toSshConnectionRequest(info).password).toBe("secret");
  });

  it("keeps missing backend fields explicit", () => {
    expect(buildTaskSshInfo({ id: 1 })).toMatchObject({
      host: "-",
      port: "-",
      username: "ubuntu",
      password: "-",
      command: "-",
    });
  });

  it("refuses to compose the command when API fields fail validation", () => {
    expect(buildTaskSshInfo({ id: 1, ip: "host; rm -rf /" }).command).toBe("-");
    expect(buildTaskSshInfo({ id: 1, ip: "10.0.0.8", port: 30222, ssh_username: "ro ot" }).command).toBe("-");
  });
});

describe("formatSshCommand", () => {
  it("composes bare arguments for validated fields", () => {
    expect(formatSshCommand({ host: "10.0.0.8", port: "30222", username: "ubuntu" })).toBe(
      "ssh -p 30222 ubuntu@10.0.0.8",
    );
    expect(formatSshCommand({ host: "[::1]", username: "root" })).toBe("ssh root@[::1]");
    expect(formatSshCommand({ host: "h" })).toBe("ssh h");
    expect(formatSshCommand({ host: "h", port: "-", username: "-" })).toBe("ssh h");
  });

  it("refuses to render missing or unvalidated fields", () => {
    expect(formatSshCommand({ host: "-" })).toBeNull();
    expect(formatSshCommand({ host: "" })).toBeNull();
    expect(formatSshCommand({ host: "host; rm -rf /" })).toBeNull();
    expect(formatSshCommand({ host: "h", username: "ro ot" })).toBeNull();
    expect(formatSshCommand({ host: "h", username: "root@host" })).toBeNull();
    expect(formatSshCommand({ host: "h", port: "0" })).toBeNull();
    expect(formatSshCommand({ host: "h", port: "70000" })).toBeNull();
  });

  it("shell-quotes arguments that are not safe words", () => {
    expect(quoteSshArg("safe-host_1.[::1]")).toBe("safe-host_1.[::1]");
    expect(quoteSshArg("a b")).toBe("'a b'");
    expect(quoteSshArg("it's")).toBe("'it'\\''s'");
  });
});

describe("resolveSshConnectionRequest", () => {
  beforeEach(() => {
    setRuntimeSettings(DEFAULT_APP_SETTINGS);
  });

  it("fills gaps from SSH settings while keeping explicit values", () => {
    setRuntimeSettings({
      ssh: {
        ...getRuntimeSettings().ssh,
        defaultPort: 30222,
        defaultUsername: "ops",
        authMode: "key",
        sshKeyPath: "~/.ssh/id_ed25519",
        keepaliveIntervalSec: 0,
      },
    });

    const resolved = resolveSshConnectionRequest({
      host: " 10.0.0.8 ",
      username: "root",
      password: " secret ",
      command: "",
    });

    expect(resolved).toMatchObject({
      host: "10.0.0.8",
      port: "30222",
      username: "root",
      password: "secret",
      // The settings auth mode fills the gap the request left open.
      authMode: "key",
      sshKeyPath: "~/.ssh/id_ed25519",
      keepaliveIntervalSec: 0,
      connectTimeoutSec: DEFAULT_APP_SETTINGS.ssh.connectTimeoutSec,
    });
  });

  it("applies settings defaults for every unset field", () => {
    const resolved = resolveSshConnectionRequest({ host: "host.example", command: "" });
    const ssh = DEFAULT_APP_SETTINGS.ssh;
    expect(resolved).toMatchObject({
      port: String(ssh.defaultPort),
      username: ssh.defaultUsername,
      cols: ssh.defaultCols,
      rows: ssh.defaultRows,
      termType: ssh.termType,
      authMode: ssh.authMode,
    });
  });

  it("prefers measured terminal size over settings defaults", () => {
    const resolved = resolveSshConnectionRequest(
      { host: "h", command: "" },
      { cols: 111, rows: 33 },
    );
    expect(resolved.cols).toBe(111);
    expect(resolved.rows).toBe(33);
  });

  it("passes keepaliveIntervalSec=0 through as the disabled value", () => {
    const resolved = resolveSshConnectionRequest({ host: "h", command: "", keepaliveIntervalSec: 0 });
    expect(resolved.keepaliveIntervalSec).toBe(0);
  });

  it("treats '-' and blank ports as unset", () => {
    expect(resolveSshConnectionRequest({ host: "h", command: "", port: "-" }).port).toBe(
      String(DEFAULT_APP_SETTINGS.ssh.defaultPort),
    );
    expect(resolveSshConnectionRequest({ host: "h", command: "", port: "  " }).port).toBe(
      String(DEFAULT_APP_SETTINGS.ssh.defaultPort),
    );
  });
});

describe("findSshConnectionIssue", () => {
  it("accepts a valid request", () => {
    expect(findSshConnectionIssue({ host: "10.0.0.8", port: "22", username: "root", command: "" })).toBeNull();
  });

  it("rejects empty hosts, bad hostnames, bad ports, and bad usernames", () => {
    expect(findSshConnectionIssue({ host: "  ", command: "" })).not.toBeNull();
    expect(findSshConnectionIssue({ host: "host;rm", command: "" })).not.toBeNull();
    expect(findSshConnectionIssue({ host: "h", port: "0", command: "" })).not.toBeNull();
    expect(findSshConnectionIssue({ host: "h", port: "70000", command: "" })).not.toBeNull();
    expect(findSshConnectionIssue({ host: "h", username: "ro ot", command: "" })).not.toBeNull();
    expect(findSshConnectionIssue({ host: "h", username: "root@host", command: "" })).not.toBeNull();
  });
});
