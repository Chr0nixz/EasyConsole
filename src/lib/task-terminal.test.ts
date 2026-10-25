import { describe, expect, it } from "vitest";

import { getTaskAccess, resolveTaskTerminalAction, willOpenAppSshSession } from "./task-terminal";
import type { Task } from "./types";

const connectedTask = {
  id: 1,
  task_id: "task-1",
  name: "demo",
  ip: "10.0.0.8",
  port: 30222,
} as Task;

const disconnectedTask = {
  id: 2,
  task_id: "task-2",
  name: "pending",
} as Task;

describe("resolveTaskTerminalAction", () => {
  it("opens in-app SSH when the runtime supports it and host is available", () => {
    const action = resolveTaskTerminalAction(connectedTask, {
      loginUsername: "alice",
      supportsInAppSsh: true,
    });

    expect(action.type).toBe("app-ssh");
    if (action.type !== "app-ssh") return;
    expect(action.request).toMatchObject({
      taskId: "task-1",
      host: "10.0.0.8",
      command: "ssh -p 30222 ubuntu@10.0.0.8",
    });
  });

  it("falls back to SSH info when in-app SSH is unavailable", () => {
    const action = resolveTaskTerminalAction(connectedTask, {
      loginUsername: "alice",
      supportsInAppSsh: false,
    });

    expect(action.type).toBe("ssh-info");
  });

  it("falls back to SSH info when host is missing even if in-app SSH is supported", () => {
    const action = resolveTaskTerminalAction(disconnectedTask, {
      supportsInAppSsh: true,
    });

    expect(action.type).toBe("ssh-info");
  });
});

describe("willOpenAppSshSession", () => {
  it("mirrors resolveTaskTerminalAction app-ssh vs ssh-info", () => {
    expect(
      willOpenAppSshSession(connectedTask, { loginUsername: "alice", supportsInAppSsh: true }),
    ).toBe(true);
    expect(
      willOpenAppSshSession(connectedTask, { loginUsername: "alice", supportsInAppSsh: false }),
    ).toBe(false);
    expect(willOpenAppSshSession(disconnectedTask, { supportsInAppSsh: true })).toBe(false);
  });
});

describe("getTaskAccess", () => {
  it("offers the terminal only while running and the log once started", () => {
    expect(getTaskAccess({ status: 2 })).toEqual({ terminal: true, terminalReason: undefined, log: true, logReason: undefined });

    const queued = getTaskAccess({ status: 1 });
    expect(queued.terminal).toBe(false);
    expect(queued.log).toBe(false);
    expect(queued.terminalReason).toBe(queued.logReason);

    const failed = getTaskAccess({ status: 7 });
    expect(failed).toMatchObject({ terminal: false, log: true });
    expect(failed.terminalReason).toBeTruthy();
    expect(getTaskAccess({ status: 3 }).terminalReason).not.toBe(failed.terminalReason);
  });
});
