import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { UnknownRecord } from "../../src/lib/types";
import { appendRunLog, clearRunLogs, filterRunLogs, formatRunLogExport, loadRunLogs, type RunLogChannel, type RunLogResult, type RunLogSource } from "../../src/lib/run-logs";
import { createEasyConsoleContext, type EasyConsoleContext, type EasyConsoleContextOptions } from "./context";
import {
  buildCreateTaskPayload,
  createTask,
  deleteStoragePath,
  deleteTask,
  downloadStoragePath,
  getTaskLog,
  listImages,
  listPrices,
  listResources,
  listStorage,
  listTasks,
  mkdirStorage,
  monitorUrl,
  readStorageText,
  releaseTask,
  setDefaultImage,
  userInfo,
} from "./operations";

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
  if (name.includes("_task_")) return "task";
  if (name.includes("_storage_")) return "storage";
  if (name.includes("_image_")) return "image";
  if (name.includes("_user_")) return "auth";
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
