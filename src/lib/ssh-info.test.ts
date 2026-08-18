import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS, getRuntimeSettings, setRuntimeSettings } from "./app-settings";
import { buildTaskSshInfo, getTaskSshId, toSshConnectionRequest } from "./ssh-info";
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
});
