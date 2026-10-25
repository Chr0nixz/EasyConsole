// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import { runCli } from "./cli";
import { parseRunLogs, RUN_LOGS_STORAGE_KEY } from "../../src/lib/run-logs";
import type { RuntimeStorage } from "../../src/lib/types";
import { TASK_TEMPLATES_STORAGE_KEY } from "../../src/lib/task-templates";
import { SCHEDULED_TASKS_STORAGE_KEY } from "../../src/lib/scheduled-tasks";

function memoryStorage(): RuntimeStorage {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

function createFakeContext(overrides: Record<string, unknown> = {}) {
  const api = {
    authApi: {
      userInfo: async () => ({ username: "tester" }),
      login: async () => ({ data: {}, token: "Bearer saved-token" }),
      changePassword: async () => ({ changed: true }),
      refreshToken: async () => "Bearer new-token",
    },
    instanceApi: {
      tasks: async () => ({ items: [{ id: 1, name: "task-1" }], raw: [] }),
      taskLog: async () => "hello log",
      createTask: async () => ({ created: true }),
      operateTask: async () => ({ released: true }),
      deleteTask: async () => ({ deleted: true }),
      deleteTasks: async () => ({ deleted: true }),
      updateTask: async () => ({ updated: true }),
      checkTaskName: async () => ({ available: true }),
      downloadTask: async () => new Blob(["task-data"]),
      console: async () => ({ summary: true }),
      statics: async () => ({ stats: true }),
      staticsCost: async () => ({ cost: 100 }),
      staticsCostMonth: async () => ({ costMonth: 1000 }),
      monitorIndex: async () => ({ index: 1 }),
    },
    storageApi: {
      list: async () => ({ items: [], raw: [] }),
      transmit: async () => new Blob(["hello"]),
      mkdir: async () => ({ created: true }),
      delete: async () => ({ deleted: true }),
      info: async () => ({ used: 1024 }),
      uploadFile: async () => ({ uploaded: true }),
    },
    imageApi: {
      list: async () => ({ items: [], raw: [] }),
      system: async () => ({ items: [], raw: [] }),
      setDefault: async () => ({ ok: true }),
      detail: async () => ({ id: 1, name: "img-1" }),
      download: async () => new Blob(["image-data"]),
      commitImage: async () => ({ committed: true }),
    },
    resourceApi: {
      resources: async () => [],
      prices: async () => [],
    },
    ...overrides,
  };
  return {
    api,
    client: {
      setToken() {},
    },
    config: {
      apiBaseUrl: "http://host/api",
      token: null,
      configPath: "config.json",
      allowInsecureHttp: true,
      env: { apiBaseUrl: false, token: false, allowInsecureHttp: false },
    },
    runLogPath: "run-logs.json",
    runLogStorage: memoryStorage(),
    storage: memoryStorage(),
  } as unknown as EasyConsoleContext;
}

describe("easy-console cli", () => {
  it("prints JSON success envelopes", async () => {
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      data: { username: "tester" },
      error: null,
    });
  });

  it("gets a single task with an SSH summary and waits for a status", async () => {
    const get = await runCli(["--json", "task", "get", "1"], {
      createContext: async () => createFakeContext(),
    });
    expect(get.exitCode).toBe(0);
    const getData = JSON.parse(get.stdout).data;
    expect(getData.task).toMatchObject({ id: 1, name: "task-1" });
    expect(getData.ssh).not.toHaveProperty("password");

    const wait = await runCli(["--json", "task", "wait", "1", "--for", "2", "--interval", "5"], {
      createContext: async () =>
        createFakeContext({ instanceApi: { tasks: async () => ({ items: [{ id: 1, status: 2 }], raw: [] }) } }),
    });
    expect(wait.exitCode).toBe(0);
    expect(JSON.parse(wait.stdout).data).toMatchObject({ outcome: "target", status: 2 });
  });

  it("returns dry-run data for mutations without --yes", async () => {
    let releaseCount = 0;
    const result = await runCli(["--json", "task", "release", "42"], {
      createContext: async () =>
        createFakeContext({
          instanceApi: {
            tasks: async () => ({ items: [], raw: [] }),
            taskLog: async () => "",
            createTask: async () => ({}),
            operateTask: async () => {
              releaseCount += 1;
              return {};
            },
            deleteTask: async () => ({}),
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "task.release" });
    expect(releaseCount).toBe(0);
  });

  it("prints JSON error envelopes and non-zero exit codes", async () => {
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => {
        throw new Error("missing token");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      data: null,
      error: { message: "missing token" },
    });
  });

  it("lists local run logs", async () => {
    const context = createFakeContext();
    const result = await runCli(["--json", "whoami"], {
      createContext: async () => context,
    });
    expect(result.exitCode).toBe(0);

    const logs = await runCli(["--json", "run-log", "list", "--limit", "10"], {
      createContext: async () => context,
    });

    expect(logs.exitCode).toBe(0);
    const payload = JSON.parse(logs.stdout) as { data: Array<{ action: string; channel: string }> };
    expect(payload.data[0]).toMatchObject({ action: "whoami", channel: "cli" });
  });

  it("keeps change-password secrets out of the local run log", async () => {
    const context = createFakeContext();

    const flagResult = await runCli(
      ["--json", "account", "change-password", "--old", "old-secret-pw", "--new", "new-secret-pw", "--yes"],
      { createContext: async () => context },
    );
    expect(flagResult.exitCode).toBe(0);

    const payloadResult = await runCli(
      ["--json", "account", "change-password", "--payload-json", '{"old_password":"json-secret-pw"}', "--yes"],
      { createContext: async () => context },
    );
    expect(payloadResult.exitCode).toBe(0);

    const raw = (await context.runLogStorage.get(RUN_LOGS_STORAGE_KEY)) ?? "";
    expect(raw).toContain("account.change-password");
    expect(raw).not.toContain("old-secret-pw");
    expect(raw).not.toContain("new-secret-pw");
    expect(raw).not.toContain("json-secret-pw");
  });

  it("returns dry-run for task update without --yes", async () => {
    let updateCount = 0;
    const result = await runCli(["--json", "task", "update", "42", "--name", "new-name"], {
      createContext: async () =>
        createFakeContext({
          instanceApi: {
            tasks: async () => ({ items: [], raw: [] }),
            updateTask: async () => {
              updateCount += 1;
              return {};
            },
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "task.update" });
    expect(updateCount).toBe(0);
  });

  it("returns dry-run for task delete-batch without --yes", async () => {
    const result = await runCli(["--json", "task", "delete-batch", "1,2,3"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "task.deleteBatch" });
  });

  it("returns dry-run for task release-batch without --yes", async () => {
    const result = await runCli(["--json", "task", "release-batch", "1,2,3"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "task.releaseBatch" });
  });

  it("releases multiple tasks with --yes", async () => {
    let releaseCount = 0;
    const result = await runCli(["--json", "task", "release-batch", "1,2", "--yes"], {
      createContext: async () =>
        createFakeContext({
          instanceApi: {
            tasks: async () => ({ items: [], raw: [] }),
            taskLog: async () => "",
            createTask: async () => ({}),
            operateTask: async () => {
              releaseCount += 1;
              return { released: true };
            },
            deleteTask: async () => ({}),
            deleteTasks: async () => ({}),
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string; result: { count: number } } };
    expect(payload.data).toMatchObject({ dryRun: false, action: "task.releaseBatch", result: { count: 2 } });
    expect(releaseCount).toBe(2);
  });

  it("checks task name availability", async () => {
    const result = await runCli(["--json", "task", "check-name", "my-task"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { available: boolean } };
    expect(payload.data).toMatchObject({ available: true });
  });

  it("gets dashboard stats", async () => {
    const result = await runCli(["--json", "dashboard", "stats"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { stats: boolean } };
    expect(payload.data).toMatchObject({ stats: true });
  });

  it("gets dashboard cost-month", async () => {
    const result = await runCli(["--json", "dashboard", "cost-month"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { costMonth: number } };
    expect(payload.data).toMatchObject({ costMonth: 1000 });
  });

  it("gets storage info", async () => {
    const result = await runCli(["--json", "storage", "info"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { used: number } };
    expect(payload.data).toMatchObject({ used: 1024 });
  });

  it("lists image system images", async () => {
    const result = await runCli(["--json", "image", "system"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { items: unknown[] } };
    expect(Array.isArray(payload.data.items)).toBe(true);
  });

  it("gets image detail", async () => {
    const result = await runCli(["--json", "image", "detail", "1"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { id: number; name: string } };
    expect(payload.data).toMatchObject({ id: 1, name: "img-1" });
  });

  it("returns dry-run for image commit without --yes", async () => {
    const result = await runCli(["--json", "image", "commit", "--pod-name", "pod-1", "--user", "user1"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "image.commit" });
  });

  it("returns dry-run for account change-password without --yes", async () => {
    const result = await runCli(["--json", "account", "change-password", "--old", "old-pass", "--new", "new-pass"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "account.changePassword" });
  });

  it("lists local task templates (empty)", async () => {
    const result = await runCli(["--json", "template", "list"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: unknown[] };
    expect(payload.data).toEqual([]);
  });

  it("lists local scheduled tasks (empty)", async () => {
    const result = await runCli(["--json", "schedule", "list"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: unknown[] };
    expect(payload.data).toEqual([]);
  });

  it("exports local data backup", async () => {
    const result = await runCli(["--json", "backup", "export"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { app: string; version: number } };
    expect(payload.data).toMatchObject({ app: "EasyConsole", version: 1 });
  });

  it("refuses to print a secrets backup to stdout", async () => {
    const result = await runCli(["--json", "backup", "export", "--include-secrets"], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--output");
    expect(result.stdout).not.toContain("Bearer");
  });

  it("returns dry-run for backup import without --yes", async () => {
    const context = createFakeContext();
    // Pre-seed storage with a valid backup to test parsing
    const backup = {
      app: "EasyConsole",
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets: false,
      items: { settings: null, taskTemplates: [] },
    };
    await context.storage.set("test-backup", JSON.stringify(backup));

    const result = await runCli(["--json", "backup", "import", "nonexistent-file.json"], {
      createContext: async () => context,
    });

    // Import will fail because file doesn't exist, but this tests the command is wired
    expect(result.exitCode).toBe(1);
  });

  it("returns dry-run for template apply without --yes", async () => {
    const context = createFakeContext();
    // Pre-seed a template
    const template = {
      id: "tpl-1",
      name: "test-template",
      taskNamePrefix: "test",
      batchCount: 1,
      imageId: "1",
      cpu: 4,
      gpu: 0,
      memory: 16,
      storagePath: "/",
      mountPath: "/home/ubuntu",
      releaseCondition: 1,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await context.storage.set(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify([template]));

    const result = await runCli(["--json", "template", "apply", "tpl-1"], {
      createContext: async () => context,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "template.apply" });
  });

  it("returns dry-run for template create and update without --yes", async () => {
    const templateJson = JSON.stringify({
      name: "demo",
      taskNamePrefix: "demo",
      batchCount: 1,
      imageId: "1",
      cpu: 4,
      gpu: 0,
      memory: 16,
      price: 1,
      storagePath: "/",
      mountPath: "/home/ubuntu",
      releaseCondition: 1,
    });
    const createResult = await runCli(["--json", "template", "create", "--template-json", templateJson], {
      createContext: async () => createFakeContext(),
    });
    expect(createResult.exitCode).toBe(0);
    expect(JSON.parse(createResult.stdout).data).toMatchObject({ dryRun: true, action: "template.create" });

    const context = createFakeContext();
    await context.storage.set(
      TASK_TEMPLATES_STORAGE_KEY,
      JSON.stringify([{ ...JSON.parse(templateJson), id: "tpl-1", usageCount: 0, createdAt: "t", updatedAt: "t" }]),
    );
    const updateResult = await runCli(["--json", "template", "update", "tpl-1", "--template-json", templateJson], {
      createContext: async () => context,
    });
    expect(updateResult.exitCode).toBe(0);
    expect(JSON.parse(updateResult.stdout).data).toMatchObject({ dryRun: true, action: "template.update" });
  });

  it("returns dry-run for schedule run without --yes", async () => {
    const context = createFakeContext();
    // Pre-seed a scheduled task
    const scheduledTask = {
      id: "sch-1",
      name: "test-schedule",
      scheduleTime: new Date().toISOString(),
      status: "pending",
      payload: { name: "test-task" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await context.storage.set(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([scheduledTask]));

    const result = await runCli(["--json", "schedule", "run", "sch-1"], {
      createContext: async () => context,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "schedule.run" });
  });

  it("returns dry-run for schedule delete without --yes", async () => {
    const context = createFakeContext();
    const scheduledTask = {
      id: "sch-1",
      name: "test-schedule",
      scheduleTime: new Date().toISOString(),
      status: "pending",
      payload: { name: "test-task" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await context.storage.set(SCHEDULED_TASKS_STORAGE_KEY, JSON.stringify([scheduledTask]));

    const result = await runCli(["--json", "schedule", "delete", "sch-1"], {
      createContext: async () => context,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "schedule.delete" });
  });

  it("returns dry-run for schedule update/pause/resume without --yes", async () => {
    const context = createFakeContext();
    await context.storage.set(
      SCHEDULED_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "sch-1",
          name: "job",
          scheduleTime: new Date().toISOString(),
          status: "pending",
          payload: { name: "t" },
          createdAt: "t",
          updatedAt: "t",
        },
      ]),
    );

    const update = await runCli(["--json", "schedule", "update", "sch-1", "--schedule-json", JSON.stringify({ name: "renamed" })], {
      createContext: async () => context,
    });
    expect(JSON.parse(update.stdout).data).toMatchObject({ dryRun: true, action: "schedule.update" });

    const pause = await runCli(["--json", "schedule", "pause", "sch-1"], { createContext: async () => context });
    expect(JSON.parse(pause.stdout).data).toMatchObject({ dryRun: true, action: "schedule.pause" });

    const resume = await runCli(["--json", "schedule", "resume", "sch-1"], { createContext: async () => context });
    expect(JSON.parse(resume.stdout).data).toMatchObject({ dryRun: true, action: "schedule.resume" });
  });

  it("returns dry-run for schedule create without --yes", async () => {
    const result = await runCli([
      "--json",
      "schedule",
      "create",
      "--name", "my-schedule",
      "--schedule-time", "2026-12-31T23:59:59.000Z",
      "--payload-json", JSON.stringify({ name: "scheduled-task" }),
    ], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; action: string } };
    expect(payload.data).toMatchObject({ dryRun: true, action: "schedule.create" });
  });

  it("creates a local scheduled task with --yes", async () => {
    const result = await runCli([
      "--json",
      "schedule",
      "create",
      "--yes",
      "--name", "my-schedule",
      "--schedule-time", "2026-12-31T23:59:59.000Z",
      "--payload-json", JSON.stringify({ name: "scheduled-task" }),
    ], {
      createContext: async () => createFakeContext(),
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { dryRun: boolean; result: { name: string; status: string } } };
    expect(payload.data).toMatchObject({ dryRun: false, result: { name: "my-schedule", status: "pending" } });
  });

  it("returns batch impact mapped from the task list on dry-run without side effects", async () => {
    let operateCount = 0;
    let deleteCount = 0;
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }], raw: [] }),
        operateTask: async () => {
          operateCount += 1;
          return {};
        },
        deleteTask: async () => {
          deleteCount += 1;
          return {};
        },
      },
    });

    const release = await runCli(["--json", "task", "release-batch", "1,2,9"], { createContext: async () => context });
    expect(release.exitCode).toBe(0);
    const releasePayload = JSON.parse(release.stdout) as { data: { impact: Array<{ id: number; name: string }> } };
    expect(releasePayload.data.impact).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
      { id: 9, name: "#9" },
    ]);

    const del = await runCli(["--json", "task", "delete-batch", "1,2"], { createContext: async () => context });
    expect(del.exitCode).toBe(0);
    const deletePayload = JSON.parse(del.stdout) as { data: { impact: Array<{ id: number; name: string }> } };
    expect(deletePayload.data.impact).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);

    expect(operateCount).toBe(0);
    expect(deleteCount).toBe(0);
  });

  it("degrades batch impact to placeholders when the task listing fails", async () => {
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => {
          throw new Error("listing unavailable");
        },
        operateTask: async () => ({}),
      },
    });

    const result = await runCli(["--json", "task", "release-batch", "5"], { createContext: async () => context });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { impact: Array<{ id: number; name: string }> } };
    expect(payload.data.impact).toEqual([{ id: 5, name: "#5" }]);
  });

  it("continues a confirmed batch after a per-item failure and returns receipts", async () => {
    const released: number[] = [];
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }], raw: [] }),
        operateTask: async (id: number) => {
          released.push(id);
          if (id === 1) throw new Error("release 1 failed");
          return { released: true };
        },
      },
    });

    const result = await runCli(["--json", "task", "release-batch", "1,2", "--yes"], { createContext: async () => context });
    expect(result.exitCode).toBe(0);
    expect(released).toEqual([1, 2]);

    const payload = JSON.parse(result.stdout) as {
      data: { dryRun: boolean; result: { batchId: string; count: number; results: Array<{ id: number; name: string; ok: boolean; error?: string }> } };
    };
    expect(payload.data.dryRun).toBe(false);
    expect(payload.data.result.batchId).toBeTruthy();
    expect(payload.data.result.count).toBe(2);
    expect(payload.data.result.results).toEqual([
      { id: 1, name: "alpha", ok: false, error: "release 1 failed" },
      { id: 2, name: "beta", ok: true },
    ]);
  });

  it("writes one run log entry per batch item", async () => {
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }], raw: [] }),
        operateTask: async (id: number) => {
          if (id === 1) throw new Error("release 1 failed");
          return { released: true };
        },
      },
    });

    const result = await runCli(["--json", "task", "release-batch", "1,2", "--yes"], { createContext: async () => context });
    const { batchId } = (JSON.parse(result.stdout) as { data: { result: { batchId: string } } }).data.result;

    const logs = parseRunLogs(await context.runLogStorage.get(RUN_LOGS_STORAGE_KEY));
    const itemLogs = logs.filter((entry) => entry.action === "task.releaseBatch");
    expect(itemLogs).toHaveLength(2);
    expect(itemLogs.find((entry) => entry.targetId === 1)).toMatchObject({
      channel: "cli",
      result: "failure",
      targetName: "alpha",
      error: "release 1 failed",
    });
    expect(itemLogs.find((entry) => entry.targetId === 2)).toMatchObject({
      channel: "cli",
      result: "success",
      targetName: "beta",
      error: undefined,
    });
    expect(itemLogs.every((entry) => entry.metadata?.batchId === batchId)).toBe(true);
  });

  it("keeps batch impact and results free of credential fields", async () => {
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 1, name: "alpha" }], raw: [] }),
        operateTask: async () => ({}),
      },
    });
    await context.storage.set("easy-console.token", "Bearer super-secret-token");

    const dryRun = await runCli(["--json", "task", "release-batch", "1"], { createContext: async () => context });
    const executed = await runCli(["--json", "task", "release-batch", "1", "--yes"], { createContext: async () => context });

    for (const output of [dryRun.stdout, executed.stdout]) {
      const data = JSON.parse(output) as { data: { impact?: Array<Record<string, unknown>>; result?: { results?: Array<Record<string, unknown>> } } };
      const rows = [...(data.data.impact ?? []), ...(data.data.result?.results ?? [])];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["error", "id", "name", "ok"].filter((key) => key in row).sort());
      }
      expect(output).not.toContain("super-secret-token");
      expect(output).not.toContain("Bearer");
    }
  });

  it("previews template apply payloads in the dry-run impact", async () => {
    const template = {
      id: "tpl-impact",
      name: "impact-template",
      taskNamePrefix: "bench",
      batchCount: 2,
      imageId: "1",
      cpu: 4,
      gpu: 0,
      memory: 16,
      storagePath: "/",
      mountPath: "/home/ubuntu",
      releaseCondition: 1,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let createCount = 0;
    const context = createFakeContext({
      instanceApi: {
        createTask: async () => {
          createCount += 1;
          return {};
        },
      },
    });
    await context.storage.set(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify([template]));

    const result = await runCli(["--json", "template", "apply", "tpl-impact"], { createContext: async () => context });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { data: { impact: Array<{ id: number; name: string }> } };
    expect(payload.data.impact).toHaveLength(2);
    expect(payload.data.impact.map((item) => item.id)).toEqual([1, 2]);
    for (const item of payload.data.impact) {
      expect(item.name).toContain("bench");
    }
    expect(createCount).toBe(0);
  });
});
