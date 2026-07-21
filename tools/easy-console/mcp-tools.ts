import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { UnknownRecord } from "../../src/lib/types";
import { appendRunLog, clearRunLogs, filterRunLogs, formatRunLogExport, loadRunLogs, type RunLogChannel, type RunLogResult, type RunLogSource } from "../../src/lib/run-logs";
import { nonSecretBackupSections, secretBackupSections } from "../../src/lib/local-data-backup";
import { saveEasyConsoleConfig } from "./config";
import { createEasyConsoleContext, type EasyConsoleContext, type EasyConsoleContextOptions } from "./context";
import {
  applyTaskTemplate,
  buildCreateTaskPayload,
  changePassword,
  checkTaskName,
  commitImage,
  createScheduledTaskRecord,
  createTask,
  createTaskTemplateRecord,
  deleteScheduledTask,
  deleteStoragePath,
  deleteTask,
  deleteTaskTemplate,
  deleteTasks,
  downloadImage,
  downloadStoragePath,
  downloadTask,
  exportBackup,
  getDashboardCost,
  getDashboardCostMonth,
  getDashboardStats,
  getImageDetail,
  getMonitorIndex,
  getStorageInfo,
  getTaskLog,
  importBackup,
  listImages,
  listPrices,
  listResources,
  listScheduledTasks,
  listStorage,
  listSystemImages,
  listTaskTemplates,
  listTasks,
  mkdirStorage,
  monitorUrl,
  pauseScheduledTaskRecord,
  readStorageText,
  refreshToken,
  releaseTask,
  releaseTasks,
  resumeScheduledTaskRecord,
  runScheduledTask,
  setDefaultImage,
  uploadLocalFile,
  updateScheduledTaskRecord,
  updateTask,
  updateTaskTemplateRecord,
  userInfo,
} from "./operations";
import type { EditableTaskTemplate } from "../../src/lib/task-templates";

type JsonId = string | number;
type InputSchema = Record<string, z.ZodType>;

export type EasyConsoleMcpToolDefinition = {
  name: string;
  description: string;
  inputSchema: InputSchema;
  handler(context: EasyConsoleContext, input: Record<string, unknown>): Promise<unknown>;
};

export type EasyConsoleMcpDeps = {
  createContext?: (options?: EasyConsoleContextOptions) => Promise<EasyConsoleContext>;
};

const idSchema = z.union([z.string(), z.number()]);
const optionalQuerySchema = z.record(z.string(), z.unknown()).optional();

function asId(value: unknown): JsonId {
  if (typeof value === "string" || typeof value === "number") return value;
  throw new Error("Expected string or number id.");
}

function asOptionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function asConfirm(value: unknown) {
  return value === true;
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as UnknownRecord;
}

function sourceForTool(name: string): RunLogSource {
  if (name.includes("_task_") || name.includes("_template_") || name.includes("_schedule_")) return "task";
  if (name.includes("_storage_") || name.includes("_backup_")) return "storage";
  if (name.includes("_image_") || name.includes("_dashboard_")) return "image";
  if (name.includes("_user_") || name.includes("_account_")) return "auth";
  return "system";
}

function shouldLogTool(name: string) {
  return !name.includes("_run_log_");
}

export function createMcpToolDefinitions(): EasyConsoleMcpToolDefinition[] {
  return [
    {
      name: "easyconsole_task_list",
      description: "List EasyConsole tasks.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        page_size: z.number().int().positive().optional(),
        keyword: z.string().optional(),
        name: z.string().optional(),
        status: z.union([z.string(), z.number()]).optional(),
      },
      handler(context, input) {
        return listTasks(context.api, {
          page: asOptionalNumber(input.page) ?? 1,
          page_size: asOptionalNumber(input.page_size) ?? 500,
          keyword: asOptionalString(input.keyword),
          name: asOptionalString(input.name),
          status: typeof input.status === "string" || typeof input.status === "number" ? input.status : undefined,
        });
      },
    },
    {
      name: "easyconsole_task_log",
      description: "Read an EasyConsole task log with byte truncation metadata.",
      inputSchema: {
        taskId: idSchema,
        limitBytes: z.number().int().positive().optional(),
      },
      handler(context, input) {
        return getTaskLog(context.api, asId(input.taskId), asOptionalNumber(input.limitBytes));
      },
    },
    {
      name: "easyconsole_task_create",
      description: "Create an EasyConsole task. Requires confirm=true to execute; otherwise returns a dry-run payload.",
      inputSchema: {
        payload: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return createTask(context.api, buildCreateTaskPayload(asRecord(input.payload)), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_task_release",
      description: "Release an EasyConsole task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: idSchema,
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return releaseTask(context.api, asId(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_task_release_batch",
      description: "Release multiple EasyConsole tasks. Requires confirm=true to execute.",
      inputSchema: {
        taskIds: z.array(idSchema),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        const ids = input.taskIds;
        if (!Array.isArray(ids)) throw new Error("taskIds must be an array.");
        return releaseTasks(context.api, ids as JsonId[], asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_task_delete",
      description: "Delete an EasyConsole task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: idSchema,
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return deleteTask(context.api, asId(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_storage_list",
      description: "List remote storage entries.",
      inputSchema: {
        path: z.string().optional(),
      },
      handler(context, input) {
        return listStorage(context.api, asOptionalString(input.path) ?? "/");
      },
    },
    {
      name: "easyconsole_storage_read_text",
      description: "Read a remote storage path as text with byte truncation metadata.",
      inputSchema: {
        path: z.string(),
        limitBytes: z.number().int().positive().optional(),
      },
      handler(context, input) {
        return readStorageText(context.api, String(input.path), asOptionalNumber(input.limitBytes));
      },
    },
    {
      name: "easyconsole_storage_download",
      description: "Download a remote storage path to a local file.",
      inputSchema: {
        path: z.string(),
        outputPath: z.string().optional(),
      },
      handler(context, input) {
        return downloadStoragePath(context.api, String(input.path), asOptionalString(input.outputPath));
      },
    },
    {
      name: "easyconsole_storage_mkdir",
      description: "Create a remote storage directory. Requires confirm=true to execute.",
      inputSchema: {
        path: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return mkdirStorage(context.api, String(input.path), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_storage_delete",
      description: "Delete a remote storage path. Requires confirm=true to execute.",
      inputSchema: {
        path: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return deleteStoragePath(context.api, String(input.path), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_image_list",
      description: "List EasyConsole custom and system images.",
      inputSchema: {
        query: optionalQuerySchema,
      },
      handler(context, input) {
        return listImages(context.api, asRecord(input.query));
      },
    },
    {
      name: "easyconsole_image_set_default",
      description: "Set the default image. Requires confirm=true to execute.",
      inputSchema: {
        imageId: idSchema,
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return setDefaultImage(context.api, asId(input.imageId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_user_info",
      description: "Show current EasyConsole user information.",
      inputSchema: {},
      handler(context) {
        return userInfo(context.api);
      },
    },
    {
      name: "easyconsole_resource_list",
      description: "List EasyConsole resource specs.",
      inputSchema: {},
      handler(context) {
        return listResources(context.api);
      },
    },
    {
      name: "easyconsole_price_list",
      description: "List EasyConsole prices.",
      inputSchema: {},
      handler(context) {
        return listPrices(context.api);
      },
    },
    {
      name: "easyconsole_monitor_url",
      description: "Build a Grafana monitor dashboard URL for a task id.",
      inputSchema: {
        taskId: idSchema,
      },
      handler(context, input) {
        return monitorUrl(context.api, asId(input.taskId));
      },
    },
    {
      name: "easyconsole_task_update",
      description: "Update an EasyConsole task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: idSchema,
        payload: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return updateTask(context.api, asId(input.taskId), buildCreateTaskPayload(asRecord(input.payload)), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_task_delete_batch",
      description: "Delete multiple EasyConsole tasks. Requires confirm=true to execute.",
      inputSchema: {
        taskIds: z.array(idSchema),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        const ids = input.taskIds;
        if (!Array.isArray(ids)) throw new Error("taskIds must be an array.");
        return deleteTasks(context.api, ids as JsonId[], asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_task_check_name",
      description: "Check if a task name is available.",
      inputSchema: {
        name: z.string(),
      },
      handler(context, input) {
        return checkTaskName(context.api, String(input.name));
      },
    },
    {
      name: "easyconsole_task_download",
      description: "Download task data to a local file.",
      inputSchema: {
        taskId: idSchema,
        outputPath: z.string().optional(),
      },
      handler(context, input) {
        return downloadTask(context.api, { task_id: asId(input.taskId) }, asOptionalString(input.outputPath));
      },
    },
    {
      name: "easyconsole_dashboard_stats",
      description: "Get dashboard statistics.",
      inputSchema: {
        query: optionalQuerySchema,
      },
      handler(context, input) {
        return getDashboardStats(context.api, input.query as UnknownRecord | undefined);
      },
    },
    {
      name: "easyconsole_dashboard_cost",
      description: "Get dashboard cost statistics.",
      inputSchema: {
        query: optionalQuerySchema,
      },
      handler(context, input) {
        return getDashboardCost(context.api, input.query as UnknownRecord | undefined);
      },
    },
    {
      name: "easyconsole_dashboard_cost_month",
      description: "Get dashboard monthly cost.",
      inputSchema: {},
      handler(context) {
        return getDashboardCostMonth(context.api);
      },
    },
    {
      name: "easyconsole_dashboard_monitor_index",
      description: "Get monitor index data.",
      inputSchema: {
        query: optionalQuerySchema,
      },
      handler(context, input) {
        return getMonitorIndex(context.api, input.query as UnknownRecord | undefined);
      },
    },
    {
      name: "easyconsole_image_system",
      description: "List EasyConsole system images.",
      inputSchema: {
        query: optionalQuerySchema,
      },
      handler(context, input) {
        return listSystemImages(context.api, input.query as UnknownRecord | undefined);
      },
    },
    {
      name: "easyconsole_image_detail",
      description: "Get image detail by id.",
      inputSchema: {
        imageId: idSchema,
      },
      handler(context, input) {
        return getImageDetail(context.api, asId(input.imageId));
      },
    },
    {
      name: "easyconsole_image_download",
      description: "Download an image to a local file.",
      inputSchema: {
        imageId: idSchema,
        outputPath: z.string().optional(),
      },
      handler(context, input) {
        return downloadImage(context.api, asId(input.imageId), asOptionalString(input.outputPath));
      },
    },
    {
      name: "easyconsole_image_commit",
      description: "Commit an image from a task pod. Requires confirm=true to execute.",
      inputSchema: {
        payload: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return commitImage(context.api, asRecord(input.payload) as unknown as Parameters<typeof commitImage>[1], asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_storage_upload",
      description: "Upload a local file to a remote directory. Requires confirm=true to execute.",
      inputSchema: {
        localPath: z.string(),
        remoteDirectory: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return uploadLocalFile(context.api, String(input.localPath), String(input.remoteDirectory), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_storage_info",
      description: "Show remote storage info.",
      inputSchema: {},
      handler(context) {
        return getStorageInfo(context.api);
      },
    },
    {
      name: "easyconsole_account_change_password",
      description: "Change account password. Requires confirm=true to execute.",
      inputSchema: {
        payload: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return changePassword(context.api, asRecord(input.payload), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_account_refresh_token",
      description: "Refresh the current auth token and persist the new token to config.",
      inputSchema: {},
      async handler(context) {
        if (!context.config.token) throw new Error("No current token found in config.");
        const result = await refreshToken(context.api, context.config.token);
        if (result.token) {
          await saveEasyConsoleConfig({ apiBaseUrl: context.config.apiBaseUrl, token: result.token }, context.config.configPath);
          context.client.setToken(result.token);
        }
        return result;
      },
    },
    {
      name: "easyconsole_template_list",
      description: "List local task templates.",
      inputSchema: {},
      handler(context) {
        return listTaskTemplates(context.storage);
      },
    },
    {
      name: "easyconsole_template_create",
      description: "Create a local task template. Requires confirm=true to execute.",
      inputSchema: {
        template: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return createTaskTemplateRecord(context.storage, asRecord(input.template) as unknown as EditableTaskTemplate, asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_template_update",
      description: "Update a local task template. Requires confirm=true to execute.",
      inputSchema: {
        templateId: z.string(),
        template: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return updateTaskTemplateRecord(
          context.storage,
          String(input.templateId),
          asRecord(input.template) as unknown as EditableTaskTemplate,
          asConfirm(input.confirm),
        );
      },
    },
    {
      name: "easyconsole_template_apply",
      description: "Apply a task template to create tasks. Requires confirm=true to execute.",
      inputSchema: {
        templateId: z.string(),
        variableValues: z.record(z.string(), z.string()).optional(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        const variableValues = input.variableValues
          ? (asRecord(input.variableValues) as Record<string, string>)
          : undefined;
        return applyTaskTemplate(context.storage, context.api, String(input.templateId), asConfirm(input.confirm), variableValues);
      },
    },
    {
      name: "easyconsole_template_delete",
      description: "Delete a local task template. Requires confirm=true to execute.",
      inputSchema: {
        templateId: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return deleteTaskTemplate(context.storage, String(input.templateId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_schedule_list",
      description: "List local scheduled tasks.",
      inputSchema: {},
      handler(context) {
        return listScheduledTasks(context.storage);
      },
    },
    {
      name: "easyconsole_schedule_create",
      description: "Create a local scheduled task. Requires confirm=true to persist; otherwise returns a dry-run preview.",
      inputSchema: {
        name: z.string(),
        scheduleTime: z.string(),
        payload: z.record(z.string(), z.unknown()),
        description: z.string().optional(),
        recurrence: z.record(z.string(), z.unknown()).optional(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return createScheduledTaskRecord(
          context.storage,
          {
            name: String(input.name),
            description: asOptionalString(input.description),
            scheduleTime: String(input.scheduleTime),
            payload: buildCreateTaskPayload(asRecord(input.payload)),
            recurrence: input.recurrence as unknown as Parameters<typeof createScheduledTaskRecord>[1]["recurrence"],
          },
          asConfirm(input.confirm),
        );
      },
    },
    {
      name: "easyconsole_schedule_update",
      description: "Update a local scheduled task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: z.string(),
        patch: z.record(z.string(), z.unknown()),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        const patch = asRecord(input.patch);
        if (patch.payload && typeof patch.payload === "object") {
          patch.payload = buildCreateTaskPayload(asRecord(patch.payload));
        }
        return updateScheduledTaskRecord(
          context.storage,
          String(input.taskId),
          patch as Parameters<typeof updateScheduledTaskRecord>[2],
          asConfirm(input.confirm),
        );
      },
    },
    {
      name: "easyconsole_schedule_pause",
      description: "Pause a pending scheduled task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return pauseScheduledTaskRecord(context.storage, String(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_schedule_resume",
      description: "Resume a paused or failed scheduled task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return resumeScheduledTaskRecord(context.storage, String(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_schedule_run",
      description: "Manually run a scheduled task now. Requires confirm=true to execute.",
      inputSchema: {
        taskId: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return runScheduledTask(context.storage, context.api, String(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_schedule_delete",
      description: "Delete a local scheduled task. Requires confirm=true to execute.",
      inputSchema: {
        taskId: z.string(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        return deleteScheduledTask(context.storage, String(input.taskId), asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_backup_export",
      description: "Export local data as a backup JSON object.",
      inputSchema: {
        includeSecrets: z.boolean().optional(),
      },
      handler(context, input) {
        return exportBackup(context.storage, input.includeSecrets === true);
      },
    },
    {
      name: "easyconsole_backup_import",
      description: "Import local data from a backup JSON text. Requires confirm=true to execute.",
      inputSchema: {
        backupText: z.string(),
        sections: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
      },
      handler(context, input) {
        const sections = Array.isArray(input.sections) && input.sections.length > 0
          ? (input.sections as string[])
          : [...nonSecretBackupSections, ...secretBackupSections];
        return importBackup(context.storage, String(input.backupText), sections as never, asConfirm(input.confirm));
      },
    },
    {
      name: "easyconsole_run_log_list",
      description: "List local EasyConsole run logs for CLI/MCP operations.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
        source: z.string().optional(),
        channel: z.string().optional(),
        result: z.string().optional(),
        keyword: z.string().optional(),
      },
      async handler(context, input) {
        const logs = await loadRunLogs(context.runLogStorage);
        return filterRunLogs(logs, {
          limit: asOptionalNumber(input.limit),
          source: asOptionalString(input.source) as RunLogSource | undefined,
          channel: asOptionalString(input.channel) as RunLogChannel | undefined,
          result: asOptionalString(input.result) as RunLogResult | undefined,
          keyword: asOptionalString(input.keyword),
        });
      },
    },
    {
      name: "easyconsole_run_log_export",
      description: "Export local EasyConsole run logs for CLI/MCP operations.",
      inputSchema: {},
      async handler(context) {
        return JSON.parse(formatRunLogExport(await loadRunLogs(context.runLogStorage)));
      },
    },
    {
      name: "easyconsole_run_log_clear",
      description: "Clear local EasyConsole run logs. Requires confirm=true to execute.",
      inputSchema: {
        confirm: z.boolean().optional(),
      },
      async handler(context, input) {
        if (!asConfirm(input.confirm)) return { dryRun: true, action: "run-log.clear", message: "Pass confirm=true to clear local run logs." };
        await clearRunLogs(context.runLogStorage);
        return { dryRun: false, action: "run-log.clear", cleared: true };
      },
    },
  ];
}

export async function invokeMcpToolDefinition(
  definition: EasyConsoleMcpToolDefinition,
  context: EasyConsoleContext,
  input: Record<string, unknown>,
) {
  const parsed = z.object(definition.inputSchema).parse(input);
  return definition.handler(context, parsed);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; kind?: unknown };
    return {
      message: error.message,
      code: record.code,
      status: record.status,
      kind: record.kind,
    };
  }
  return { message: String(error) };
}

export function toMcpJsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, data, error: null }, null, 2),
      },
    ],
  };
}

export function toMcpJsonError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, data: null, error: formatError(error) }, null, 2),
      },
    ],
  };
}

export function registerEasyConsoleTools(server: McpServer, deps: EasyConsoleMcpDeps = {}) {
  const createContext = deps.createContext ?? createEasyConsoleContext;
  for (const definition of createMcpToolDefinitions()) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (input) => {
        const startedAt = Date.now();
        let context: EasyConsoleContext | null = null;
        try {
          context = await createContext();
          const data = await definition.handler(context, input as Record<string, unknown>);
          if (shouldLogTool(definition.name)) {
            await appendRunLog(context.runLogStorage, {
              channel: "mcp",
              source: sourceForTool(definition.name),
              level: "info",
              action: definition.name,
              result: "success",
              title: `MCP ${definition.name} 成功`,
              durationMs: Date.now() - startedAt,
              metadata: { input },
            });
          }
          return toMcpJsonResult(data);
        } catch (error) {
          if (context && shouldLogTool(definition.name)) {
            await appendRunLog(context.runLogStorage, {
              channel: "mcp",
              source: sourceForTool(definition.name),
              level: "error",
              action: definition.name,
              result: "failure",
              title: `MCP ${definition.name} 失败`,
              durationMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
              metadata: { input },
            });
          }
          return toMcpJsonError(error);
        }
      },
    );
  }
}
