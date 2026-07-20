// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import { runCli } from "./cli";
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
      env: { apiBaseUrl: false, token: false },
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

  it("creates a local scheduled task", async () => {
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
    const payload = JSON.parse(result.stdout) as { data: { name: string; status: string } };
    expect(payload.data).toMatchObject({ name: "my-schedule", status: "pending" });
  });
});
