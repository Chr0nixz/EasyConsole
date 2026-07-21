// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import type { RuntimeStorage } from "../../src/lib/types";
import { TASK_TEMPLATES_STORAGE_KEY } from "../../src/lib/task-templates";
import { SCHEDULED_TASKS_STORAGE_KEY } from "../../src/lib/scheduled-tasks";
import { createMcpToolDefinitions, invokeMcpToolDefinition, toMcpJsonError, toMcpJsonResult } from "./mcp-tools";

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

function getTool(name: string) {
  const tool = createMcpToolDefinitions().find((definition) => definition.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function createFakeContext(overrides: Record<string, unknown> = {}) {
  const api = {
    authApi: {
      userInfo: async () => ({ username: "tester" }),
      changePassword: async () => ({ changed: true }),
      refreshToken: async () => "Bearer new-token",
    },
    instanceApi: {
      tasks: async () => ({ items: [{ id: 7, description: "pod-7" }], raw: [] }),
      taskLog: async () => "log text",
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

describe("easy-console MCP tools", () => {
  it("validates tool input with zod schemas", async () => {
    await expect(invokeMcpToolDefinition(getTool("easyconsole_task_log"), createFakeContext(), {})).rejects.toThrow();
  });

  it("does not call mutation APIs without confirm=true", async () => {
    let releaseCount = 0;
    const context = createFakeContext({
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
    });

    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release"), context, { taskId: 7 });

    expect(result).toMatchObject({ dryRun: true, action: "task.release" });
    expect(releaseCount).toBe(0);
  });

  it("executes confirmed mutations", async () => {
    let releaseCount = 0;
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [], raw: [] }),
        taskLog: async () => "",
        createTask: async () => ({}),
        operateTask: async () => {
          releaseCount += 1;
          return { released: true };
        },
        deleteTask: async () => ({}),
      },
    });

    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release"), context, { taskId: 7, confirm: true });

    expect(result).toMatchObject({ dryRun: false, action: "task.release", result: { released: true } });
    expect(releaseCount).toBe(1);
  });

  it("wraps MCP results as structured JSON text", () => {
    expect(JSON.parse(toMcpJsonResult({ ok: true }).content[0].text)).toEqual({
      ok: true,
      data: { ok: true },
      error: null,
    });
    expect(JSON.parse(toMcpJsonError(new Error("boom")).content[0].text)).toMatchObject({
      ok: false,
      data: null,
      error: { message: "boom" },
    });
  });

  it("exposes run log tools", () => {
    expect(getTool("easyconsole_run_log_list")).toBeTruthy();
    expect(getTool("easyconsole_run_log_export")).toBeTruthy();
    expect(getTool("easyconsole_run_log_clear")).toBeTruthy();
  });

  it("exposes all 24 new tool definitions", () => {
    const expectedTools = [
      "easyconsole_task_update",
      "easyconsole_task_delete_batch",
      "easyconsole_task_release_batch",
      "easyconsole_task_check_name",
      "easyconsole_task_download",
      "easyconsole_dashboard_stats",
      "easyconsole_dashboard_cost",
      "easyconsole_dashboard_cost_month",
      "easyconsole_dashboard_monitor_index",
      "easyconsole_image_system",
      "easyconsole_image_detail",
      "easyconsole_image_download",
      "easyconsole_image_commit",
      "easyconsole_storage_upload",
      "easyconsole_storage_info",
      "easyconsole_account_change_password",
      "easyconsole_account_refresh_token",
      "easyconsole_template_list",
      "easyconsole_template_create",
      "easyconsole_template_update",
      "easyconsole_template_apply",
      "easyconsole_template_delete",
      "easyconsole_schedule_list",
      "easyconsole_schedule_create",
      "easyconsole_schedule_update",
      "easyconsole_schedule_pause",
      "easyconsole_schedule_resume",
      "easyconsole_schedule_run",
      "easyconsole_schedule_delete",
      "easyconsole_backup_export",
      "easyconsole_backup_import",
    ];
    for (const name of expectedTools) {
      expect(getTool(name)).toBeTruthy();
    }
  });

  it("returns dry-run for task_update without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_update"), createFakeContext(), {
      taskId: 42,
      payload: { name: "new-name" },
    });
    expect(result).toMatchObject({ dryRun: true, action: "task.update" });
  });

  it("returns dry-run for task_delete_batch without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_delete_batch"), createFakeContext(), {
      taskIds: [1, 2, 3],
    });
    expect(result).toMatchObject({ dryRun: true, action: "task.deleteBatch" });
  });

  it("returns dry-run for task_release_batch without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), createFakeContext(), {
      taskIds: [1, 2, 3],
    });
    expect(result).toMatchObject({ dryRun: true, action: "task.releaseBatch" });
  });

  it("releases multiple tasks with confirm", async () => {
    let releaseCount = 0;
    const context = createFakeContext({
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
    });
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), context, {
      taskIds: [1, 2],
      confirm: true,
    });
    expect(result).toMatchObject({ dryRun: false, action: "task.releaseBatch", result: { count: 2 } });
    expect(releaseCount).toBe(2);
  });

  it("checks task name via task_check_name", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_check_name"), createFakeContext(), {
      name: "my-task",
    });
    expect(result).toMatchObject({ available: true });
  });

  it("gets dashboard stats", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_dashboard_stats"), createFakeContext(), {});
    expect(result).toMatchObject({ stats: true });
  });

  it("gets dashboard cost-month", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_dashboard_cost_month"), createFakeContext(), {});
    expect(result).toMatchObject({ costMonth: 1000 });
  });

  it("gets storage info", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_storage_info"), createFakeContext(), {});
    expect(result).toMatchObject({ used: 1024 });
  });

  it("gets image detail", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_image_detail"), createFakeContext(), { imageId: 1 });
    expect(result).toMatchObject({ id: 1, name: "img-1" });
  });

  it("returns dry-run for image_commit without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_image_commit"), createFakeContext(), {
      payload: { pod_name: "pod-1", user: "user1" },
    });
    expect(result).toMatchObject({ dryRun: true, action: "image.commit" });
  });

  it("returns dry-run for account_change_password without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_account_change_password"), createFakeContext(), {
      payload: { old_password: "old", new_password: "new" },
    });
    expect(result).toMatchObject({ dryRun: true, action: "account.changePassword" });
  });

  it("lists local task templates (empty)", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_template_list"), createFakeContext(), {});
    expect(result).toEqual([]);
  });

  it("lists local scheduled tasks (empty)", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_schedule_list"), createFakeContext(), {});
    expect(result).toEqual([]);
  });

  it("exports local data backup", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_backup_export"), createFakeContext(), {});
    expect(result).toMatchObject({ app: "EasyConsole", version: 1 });
  });

  it("returns dry-run for template_apply without confirm", async () => {
    const context = createFakeContext();
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

    const result = await invokeMcpToolDefinition(getTool("easyconsole_template_apply"), context, { templateId: "tpl-1" });
    expect(result).toMatchObject({ dryRun: true, action: "template.apply" });
  });

  it("returns dry-run for schedule_run without confirm", async () => {
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

    const result = await invokeMcpToolDefinition(getTool("easyconsole_schedule_run"), context, { taskId: "sch-1" });
    expect(result).toMatchObject({ dryRun: true, action: "schedule.run" });
  });

  it("returns dry-run for schedule_delete without confirm", async () => {
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

    const result = await invokeMcpToolDefinition(getTool("easyconsole_schedule_delete"), context, { taskId: "sch-1" });
    expect(result).toMatchObject({ dryRun: true, action: "schedule.delete" });
  });

  it("returns dry-run for schedule_create without confirm", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_schedule_create"), createFakeContext(), {
      name: "my-schedule",
      scheduleTime: "2026-12-31T23:59:59.000Z",
      payload: { name: "scheduled-task" },
    });
    expect(result).toMatchObject({ dryRun: true, action: "schedule.create" });
  });

  it("creates a local scheduled task when confirm=true", async () => {
    const context = createFakeContext();
    const result = await invokeMcpToolDefinition(getTool("easyconsole_schedule_create"), context, {
      name: "my-schedule",
      scheduleTime: "2026-12-31T23:59:59.000Z",
      payload: { name: "scheduled-task" },
      confirm: true,
    });
    expect(result).toMatchObject({ dryRun: false, action: "schedule.create" });
    expect(result).toMatchObject({ result: { name: "my-schedule", status: "pending" } });
  });

  it("returns dry-run for backup_import without confirm", async () => {
    const context = createFakeContext();
    const backup = {
      app: "EasyConsole",
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets: false,
      items: { settings: null, taskTemplates: [] },
    };

    const result = await invokeMcpToolDefinition(getTool("easyconsole_backup_import"), context, {
      backupText: JSON.stringify(backup),
    });
    expect(result).toMatchObject({ dryRun: true, action: "backup.import" });
  });
});
