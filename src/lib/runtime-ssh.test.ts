import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined),
  listen: vi.fn(async () => () => {}),
  onSshEvent: null as null | ((event: { payload: { sessionId: string; kind: "closed" } }) => void),
  windowLabel: "ssh-runtime-test",
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: tauriMocks.isTauri,
  invoke: tauriMocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (eventName: string, handler: NonNullable<typeof tauriMocks.onSshEvent>) => {
    if (eventName === "ssh-session-event") tauriMocks.onSshEvent = handler;
    return tauriMocks.listen();
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: tauriMocks.windowLabel }),
}));

import { browserRuntime, getRuntimeKind, initRuntimeKind } from "./runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openTaskSession(taskId: string) {
  return browserRuntime.openSshSession({
    host: "127.0.0.1",
    port: "22",
    username: "ubuntu",
    command: "",
    taskId,
  });
}

describe("SSH runtime request ordering", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === "runtime_platform") return "desktop";
      if (command === "open_ssh_session") return "session-task-gpu-single-flight";
      return undefined;
    });
    await initRuntimeKind();
    expect(getRuntimeKind()).toBe("desktop");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shares an in-flight GPU probe per session and does not retain its result", async () => {
    const response = deferred<number[]>();
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === "runtime_platform") return "desktop";
      if (command === "open_ssh_session") return "session-task-gpu-single-flight";
      if (command === "ssh_gpu_utilization") {
        markProbeStarted();
        return response.promise;
      }
      return undefined;
    });

    await openTaskSession("task-gpu-single-flight");
    const first = browserRuntime.readTaskGpuUtilization("task-gpu-single-flight");
    const second = browserRuntime.readTaskGpuUtilization("task-gpu-single-flight");
    await probeStarted;
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === "ssh_gpu_utilization")).toHaveLength(1);

    response.resolve([0, 42]);
    await expect(first).resolves.toEqual([0, 42]);
    await expect(second).resolves.toEqual([0, 42]);
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === "ssh_gpu_utilization")).toHaveLength(1);
    await browserRuntime.readTaskGpuUtilization("task-gpu-single-flight");
    expect(tauriMocks.invoke.mock.calls.filter(([command]) => command === "ssh_gpu_utilization")).toHaveLength(2);
    await browserRuntime.closeSshSession("session-task-gpu-single-flight");
  });

  it("clears a failed GPU probe so the next request can retry", async () => {
    const failure = new Error("probe failed");
    let attempts = 0;
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === "runtime_platform") return "desktop";
      if (command === "open_ssh_session") return "session-task-gpu-retry";
      if (command === "ssh_gpu_utilization") {
        attempts += 1;
        if (attempts === 1) throw failure;
        return [17];
      }
      return undefined;
    });

    await openTaskSession("task-gpu-retry");
    await expect(browserRuntime.readTaskGpuUtilization("task-gpu-retry")).rejects.toBe(failure);
    await expect(browserRuntime.readTaskGpuUtilization("task-gpu-retry")).resolves.toEqual([17]);
    expect(attempts).toBe(2);
    await browserRuntime.closeSshSession("session-task-gpu-retry");
  });

  it("serializes writes and continues after one write fails", async () => {
    const firstWrite = deferred<void>();
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const started: string[] = [];
    tauriMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "runtime_platform") return "desktop";
      if (command === "ssh_write") {
        const data = String(args?.data);
        started.push(data);
        if (data === "first") {
          markFirstStarted();
          return firstWrite.promise;
        }
        if (data === "second") markSecondStarted();
      }
      return undefined;
    });

    const first = browserRuntime.writeSshSession("session-write", "first");
    const second = browserRuntime.writeSshSession("session-write", "second");
    await firstStarted;
    expect(started).toEqual(["first"]);

    const failure = new Error("first write failed");
    firstWrite.reject(failure);
    await expect(first).rejects.toBe(failure);
    await secondStarted;
    await expect(second).resolves.toBeUndefined();
    expect(started).toEqual(["first", "second"]);
  });

  it("closes without waiting for a stalled write and cancels queued input only for that session", async () => {
    const pendingWrite = deferred<void>();
    const pendingClose = deferred<void>();
    const writeStarted = deferred<void>();
    const sent: string[] = [];
    tauriMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "ssh_close") return pendingClose.promise;
      if (command === "ssh_write") {
        sent.push(`${args?.sessionId}:${args?.data}`);
        if (args?.data === "stalled") {
          writeStarted.resolve();
          return pendingWrite.promise;
        }
      }
      return undefined;
    });

    const stalled = browserRuntime.writeSshSession("closing-session", "stalled");
    const queued = browserRuntime.writeSshSession("closing-session", "queued");
    const stalledRejected = expect(stalled).rejects.toThrow();
    const queuedRejected = expect(queued).rejects.toThrow();
    await writeStarted.promise;
    await browserRuntime.writeSshSession("other-session", "independent");

    const closing = browserRuntime.closeSshSession("closing-session");
    await Promise.all([stalledRejected, queuedRejected]);
    await expect(browserRuntime.writeSshSession("closing-session", "after-close")).rejects.toThrow();
    pendingClose.resolve();
    await closing;
    pendingWrite.resolve();
    await browserRuntime.writeSshSession("other-session", "still-independent");
    expect(sent).toEqual([
      "closing-session:stalled", "other-session:independent", "other-session:still-independent",
    ]);
  });

  it("cancels pending input when the native session closes", async () => {
    const pendingWrite = deferred<void>();
    const writeStarted = deferred<void>();
    const sent: string[] = [];
    tauriMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "open_ssh_session") return "native-closed-session";
      if (command === "ssh_write") {
        sent.push(String(args?.data));
        writeStarted.resolve();
        return pendingWrite.promise;
      }
      return undefined;
    });
    await openTaskSession("task-native-closed");
    const first = browserRuntime.writeSshSession("native-closed-session", "first");
    const second = browserRuntime.writeSshSession("native-closed-session", "second");
    const firstRejected = expect(first).rejects.toThrow();
    const secondRejected = expect(second).rejects.toThrow();
    await writeStarted.promise;
    expect(tauriMocks.onSshEvent).not.toBeNull();
    tauriMocks.onSshEvent!({ payload: { sessionId: "native-closed-session", kind: "closed" } });
    await Promise.all([firstRejected, secondRejected]);
    pendingWrite.resolve();
    await expect(browserRuntime.readTaskGpuUtilization("task-native-closed")).resolves.toBeNull();
    expect(sent).toEqual(["first"]);
  });
});
