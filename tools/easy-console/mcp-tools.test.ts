// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { EasyConsoleContext } from "./context";
import type { RuntimeStorage } from "../../src/lib/types";
import { parseRunLogs, RUN_LOGS_STORAGE_KEY } from "../../src/lib/run-logs";
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

  it("rejects task create payloads without a name and keeps unknown fields", async () => {
    await expect(
      invokeMcpToolDefinition(getTool("easyconsole_task_create"), createFakeContext(), {
        payload: { cpu: 8, typo_field: "x" },
      }),
    ).rejects.toThrow();

    let createCount = 0;
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [], raw: [] }),
        taskLog: async () => "",
        createTask: async (payload: Record<string, unknown>) => {
          createCount += 1;
          return { payload };
        },
      },
    });
    const result = await invokeMcpToolDefinition(getTool("easyconsole_task_create"), context, {
      payload: { name: "train", cpu: 8, custom_backend_field: true },
      confirm: true,
    });
    expect(createCount).toBe(1);
    expect(JSON.stringify(result)).toContain("custom_backend_field");
  });

  it("gets a single task with an SSH summary that omits credentials", async () => {
    const result = (await invokeMcpToolDefinition(getTool("easyconsole_task_get"), createFakeContext(), {
      taskId: 7,
    })) as { task: Record<string, unknown>; ssh: Record<string, unknown>; monitorUrl: string };

    expect(result.task).toMatchObject({ id: 7, description: "pod-7" });
    expect(result.ssh).not.toHaveProperty("password");
    expect(result.ssh).not.toHaveProperty("command");
    expect(typeof result.monitorUrl).toBe("string");
  });

  it("waits for a target status and returns early on failure statuses", async () => {
    const target = await invokeMcpToolDefinition(
      getTool("easyconsole_task_wait"),
      createFakeContext({ instanceApi: { tasks: async () => ({ items: [{ id: 7, status: 2 }], raw: [] }) } }),
      { taskId: 7 },
    );
    expect(target).toMatchObject({ outcome: "target", status: 2 });

    const failed = await invokeMcpToolDefinition(
      getTool("easyconsole_task_wait"),
      createFakeContext({ instanceApi: { tasks: async () => ({ items: [{ id: 7, status: 8 }], raw: [] }) } }),
      { taskId: 7, timeoutSeconds: 30 },
    );
    expect(failed).toMatchObject({ outcome: "failed", status: 8 });
  });

  it("gates image update and delete behind confirm", async () => {
    let updateCount = 0;
    let deleteCount = 0;
    const context = createFakeContext({
      imageApi: {
        list: async () => ({ items: [], raw: [] }),
        system: async () => ({ items: [], raw: [] }),
        setDefault: async () => ({}),
        detail: async () => ({}),
        download: async () => new Blob([]),
        commitImage: async () => ({}),
        updateImage: async (id: number, payload: Record<string, unknown>) => {
          updateCount += 1;
          return { id, payload };
        },
        deleteImage: async () => {
          deleteCount += 1;
          return {};
        },
      },
    });

    const dryRun = await invokeMcpToolDefinition(getTool("easyconsole_image_delete"), context, { imageId: 3 });
    expect(dryRun).toMatchObject({ dryRun: true, action: "image.delete" });
    expect(deleteCount).toBe(0);

    const confirmed = await invokeMcpToolDefinition(getTool("easyconsole_image_delete"), context, { imageId: 3, confirm: true });
    expect(confirmed).toMatchObject({ dryRun: false });
    expect(deleteCount).toBe(1);

    const updateDryRun = await invokeMcpToolDefinition(getTool("easyconsole_image_update"), context, {
      imageId: 3,
      payload: { name: "renamed" },
    });
    expect(updateDryRun).toMatchObject({ dryRun: true, action: "image.update" });
    expect(updateCount).toBe(0);

    const updated = await invokeMcpToolDefinition(getTool("easyconsole_image_update"), context, {
      imageId: 3,
      payload: { name: "renamed" },
      confirm: true,
    });
    expect(updateCount).toBe(1);
    expect(JSON.stringify(updated)).toContain("renamed");
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

  it("requires confirm before writing a download to disk", async () => {
    const result = await invokeMcpToolDefinition(getTool("easyconsole_storage_download"), createFakeContext(), {
      path: "/remote/file.txt",
    });
    expect(result).toMatchObject({ dryRun: true, action: "storage.download" });
  });

  it("refuses download paths that escape the download root", async () => {
    await expect(
      invokeMcpToolDefinition(getTool("easyconsole_storage_download"), createFakeContext(), {
        path: "/remote/file.txt",
        outputPath: "../../../.bashrc",
        confirm: true,
      }),
    ).rejects.toThrow(/outside the download directory/);
  });

  it("never exports credentials over MCP", async () => {
    const context = createFakeContext();
    await context.storage.set("easy-console.token", "Bearer super-secret-token");
    await context.storage.set("easy-console.savedAccounts", JSON.stringify([{ id: "a", token: "Bearer super-secret-token" }]));

    const result = (await invokeMcpToolDefinition(getTool("easyconsole_backup_export"), context, {})) as {
      includeSecrets: boolean;
      items: Record<string, unknown>;
    };

    expect(result.includeSecrets).toBe(false);
    expect(result.items.token).toBeUndefined();
    expect(result.items.savedAccounts).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("rejects importing credential sections over MCP", async () => {
    const context = createFakeContext();
    const backup = {
      app: "EasyConsole",
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets: true,
      items: { token: "Bearer injected-token" },
    };

    await expect(
      invokeMcpToolDefinition(getTool("easyconsole_backup_import"), context, {
        backupText: JSON.stringify(backup),
        sections: ["token"],
        confirm: true,
      }),
    ).rejects.toThrow(/Refusing to import credential sections/);
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
    expect(result).not.toHaveProperty("note");
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
    // The store has no runner: the note must tell the agent it will not fire automatically.
    expect(result).toMatchObject({ note: expect.stringContaining("NOT run automatically") });
  });

  it("documents that local scheduled tasks never execute automatically", () => {
    for (const name of ["easyconsole_schedule_create", "easyconsole_schedule_update", "easyconsole_schedule_resume"]) {
      const tool = getTool(name);
      expect(tool.description).toContain("never executed automatically");
    }
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

  it("returns task impact on batch dry-run without side effects", async () => {
    let deleteCount = 0;
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 7, description: "pod-7" }, { id: 8, name: "train-8" }], raw: [] }),
        deleteTask: async () => {
          deleteCount += 1;
          return {};
        },
      },
    });

    const result = (await invokeMcpToolDefinition(getTool("easyconsole_task_delete_batch"), context, {
      taskIds: [7, 8, 99],
    })) as { dryRun: boolean; impact: Array<{ id: number; name: string }> };

    expect(result.dryRun).toBe(true);
    expect(result.impact).toEqual([
      { id: 7, name: "pod-7" },
      { id: 8, name: "train-8" },
      { id: 99, name: "#99" },
    ]);
    expect(deleteCount).toBe(0);
  });

  it("continues a confirmed batch after a per-item failure and reports receipts", async () => {
    const released: number[] = [];
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 7, description: "pod-7" }, { id: 8, name: "train-8" }], raw: [] }),
        operateTask: async (id: number) => {
          released.push(id);
          if (id === 7) throw new Error("release 7 failed");
          return { released: true };
        },
      },
    });

    const result = (await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), context, {
      taskIds: [7, 8],
      confirm: true,
    })) as {
      dryRun: boolean;
      result: { batchId: string; count: number; results: Array<{ id: number; name: string; ok: boolean; error?: string }> };
    };

    expect(result.dryRun).toBe(false);
    expect(released).toEqual([7, 8]);
    expect(result.result.batchId).toBeTruthy();
    expect(result.result.count).toBe(2);
    expect(result.result.results).toEqual([
      { id: 7, name: "pod-7", ok: false, error: "release 7 failed" },
      { id: 8, name: "train-8", ok: true },
    ]);
  });

  it("writes one mcp run log entry per batch item", async () => {
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 7, description: "pod-7" }, { id: 8, name: "train-8" }], raw: [] }),
        operateTask: async (id: number) => {
          if (id === 7) throw new Error("release 7 failed");
          return { released: true };
        },
      },
    });

    const result = (await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), context, {
      taskIds: [7, 8],
      confirm: true,
    })) as { result: { batchId: string } };

    const logs = parseRunLogs(await context.runLogStorage.get(RUN_LOGS_STORAGE_KEY));
    const itemLogs = logs.filter((entry) => entry.action === "task.releaseBatch");
    expect(itemLogs).toHaveLength(2);
    expect(itemLogs.find((entry) => entry.targetId === 7)).toMatchObject({
      channel: "mcp",
      result: "failure",
      targetName: "pod-7",
      error: "release 7 failed",
    });
    expect(itemLogs.find((entry) => entry.targetId === 8)).toMatchObject({
      channel: "mcp",
      result: "success",
      targetName: "train-8",
    });
    expect(itemLogs.every((entry) => entry.metadata?.batchId === result.result.batchId)).toBe(true);
  });

  it("keeps batch impact and results free of credential fields", async () => {
    const context = createFakeContext({
      instanceApi: {
        tasks: async () => ({ items: [{ id: 7, description: "pod-7" }], raw: [] }),
        operateTask: async () => ({}),
      },
    });
    await context.storage.set("easy-console.token", "Bearer super-secret-token");

    const dryRun = await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), context, { taskIds: [7] });
    const executed = await invokeMcpToolDefinition(getTool("easyconsole_task_release_batch"), context, {
      taskIds: [7],
      confirm: true,
    });

    for (const data of [dryRun, executed]) {
      const serialized = JSON.stringify(data);
      const rows = [
        ...((data as { impact?: Array<Record<string, unknown>> }).impact ?? []),
        ...(((data as { result?: { results?: Array<Record<string, unknown>> } }).result?.results) ?? []),
      ];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["error", "id", "name", "ok"].filter((key) => key in row).sort());
      }
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain("Bearer");
    }
  });

  it("previews template apply payloads in the dry-run impact", async () => {
    const context = createFakeContext();
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
    await context.storage.set(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify([template]));

    const result = (await invokeMcpToolDefinition(getTool("easyconsole_template_apply"), context, {
      templateId: "tpl-impact",
    })) as { dryRun: boolean; impact: Array<{ id: number; name: string }> };

    expect(result.dryRun).toBe(true);
    expect(result.impact).toHaveLength(2);
    expect(result.impact.map((item) => item.id)).toEqual([1, 2]);
    for (const item of result.impact) {
      expect(item.name).toContain("bench");
    }
  });
});
