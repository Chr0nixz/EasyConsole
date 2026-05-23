import { describe, expect, it } from "vitest";

import { buildTaskSshInfo, getTaskSshId, toSshConnectionRequest } from "./ssh-info";
import type { Task } from "./types";

describe("ssh info", () => {
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
      password: "alice",
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
      password: "alice",
      command: "ssh -p 30222 ubuntu@10.0.0.8",
      taskId: "task-1",
      taskName: "demo",
    });
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
