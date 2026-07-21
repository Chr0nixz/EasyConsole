import { Command, CommanderError } from "commander";

import type { CreateTaskPayload, ImageCommitPayload, TaskQuery, TaskRecurrence, UnknownRecord } from "../../src/lib/types";
import { appendRunLog, clearRunLogs, filterRunLogs, formatRunLogExport, loadRunLogs, type RunLogChannel, type RunLogResult, type RunLogSource } from "../../src/lib/run-logs";
import { nonSecretBackupSections, secretBackupSections, type LocalDataBackupSection } from "../../src/lib/local-data-backup";
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

export type CliRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CliDeps = {
  createContext?: (options: EasyConsoleContextOptions) => Promise<EasyConsoleContext>;
  readStdin?: () => Promise<string>;
};

type GlobalCliOptions = {
  apiBaseUrl?: string;
  token?: string;
  config?: string;
  runLogPath?: string;
  json?: boolean;
  allowInsecureHttp?: boolean;
};

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

function parseJsonRecord(value: string): UnknownRecord {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as UnknownRecord;
}

function parseNumber(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected a number, received ${value}`);
  return number;
}

function parseInteger(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`Expected an integer, received ${value}`);
  return number;
}

function parseId(value: string) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function compactRecord(record: UnknownRecord) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function commandPath(command: Command) {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    names.unshift(current.name());
    current = current.parent ?? null;
  }
  return names.filter((name) => name !== "easy-console").join(".");
}

function sourceForCommand(action: string): RunLogSource {
  if (action.startsWith("login") || action.startsWith("whoami") || action.startsWith("account.")) return "auth";
  if (action.startsWith("task.") || action.startsWith("template.") || action.startsWith("schedule.")) return "task";
  if (action.startsWith("storage.") || action.startsWith("backup.")) return "storage";
  if (action.startsWith("image.") || action.startsWith("dashboard.")) return "image";
  if (action.startsWith("resource.") || action.startsWith("price.") || action.startsWith("monitor-url")) return "system";
  return "system";
}

function shouldLogCommand(action: string) {
  return !action.startsWith("run-log.");
}

function buildPayloadFromOptions(options: UnknownRecord): CreateTaskPayload {
  if (typeof options.payloadJson === "string") return buildCreateTaskPayload(parseJsonRecord(options.payloadJson));
  return buildCreateTaskPayload(
    compactRecord({
      name: options.name,
      price: parseNumber(options.price as string | undefined),
      cpu: parseNumber(options.cpu as string | undefined),
      gpu: parseInteger(options.gpu as string | undefined),
      memory: parseInteger(options.memory as string | undefined),
      img: typeof options.imageId === "string" ? parseId(options.imageId) : undefined,
      storage_path: options.storagePath,
      mount_path: options.mountPath,
      releace_conditions: parseInteger(options.releaseCondition as string | undefined),
      releace_time: options.releaseTime,
      work_directory: options.workDirectory,
      script_path: options.scriptPath,
    }),
  );
}

async function defaultReadStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCli(argv = process.argv.slice(2), deps: CliDeps = {}): Promise<CliRunResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const createContext = deps.createContext ?? createEasyConsoleContext;
  const readStdin = deps.readStdin ?? defaultReadStdin;

  const program = new Command();
  program
    .name("easy-console")
    .description("EasyConsole command line interface for humans and AI agents")
    .option("--api-base-url <url>", "API base URL")
    .option("--token <token>", "Bearer token or raw token")
    .option("--config <path>", "Config file path")
    .option("--run-log-path <path>", "Run log file path")
    .option("--allow-insecure-http", "Allow remote cleartext HTTP (lab only; prefer HTTPS or http://127.0.0.1 tunnel)")
    .option("--json", "Print { ok, data, error } JSON envelopes");

  program.exitOverride();
  program.configureOutput({
    writeOut(value) {
      stdout += value;
    },
    writeErr(value) {
      stderr += value;
    },
  });

  function emitSuccess(command: Command, data: unknown) {
    const options = command.optsWithGlobals<GlobalCliOptions>();
    stdout += options.json ? `${JSON.stringify({ ok: true, data, error: null })}\n` : `${JSON.stringify(data, null, 2)}\n`;
  }

  function emitFailure(command: Command, error: unknown) {
    exitCode = 1;
    const options = command.optsWithGlobals<GlobalCliOptions>();
    const formatted = formatError(error);
    stderr += options.json ? `${JSON.stringify({ ok: false, data: null, error: formatted })}\n` : `${formatted.message}\n`;
  }

  async function getContext(command: Command) {
    const options = command.optsWithGlobals<GlobalCliOptions>();
    return createContext({
      apiBaseUrl: options.apiBaseUrl,
      token: options.token,
      configPath: options.config,
      runLogPath: options.runLogPath,
      allowInsecureHttp: options.allowInsecureHttp === true,
    });
  }

  function run(command: Command, handler: (context: EasyConsoleContext) => Promise<unknown>) {
    return async () => {
      const startedAt = Date.now();
      const action = commandPath(command);
      let context: EasyConsoleContext | null = null;
      try {
        context = await getContext(command);
        const data = await handler(context);
        if (shouldLogCommand(action)) {
          await appendRunLog(context.runLogStorage, {
            channel: "cli",
            source: sourceForCommand(action),
            level: "info",
            action,
            result: "success",
            title: `CLI ${action} 成功`,
            durationMs: Date.now() - startedAt,
            metadata: { options: command.opts() },
          });
        }
        emitSuccess(command, data);
      } catch (error) {
        if (context && shouldLogCommand(action)) {
          await appendRunLog(context.runLogStorage, {
            channel: "cli",
            source: sourceForCommand(action),
            level: "error",
            action,
            result: "failure",
            title: `CLI ${action} 失败`,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            metadata: { options: command.opts() },
          });
        }
        emitFailure(command, error);
      }
    };
  }

  const login = program.command("login").description("Login and save a local token");
  login.requiredOption("--username <name>", "Username");
  login.option("--password <password>", "Password");
  login.option("--password-stdin", "Read password from stdin");
  login.action(async () => {
    try {
      const options = login.optsWithGlobals<GlobalCliOptions & { username: string; password?: string; passwordStdin?: boolean }>();
      const password = options.passwordStdin ? (await readStdin()).trimEnd() : options.password;
      if (!password) throw new Error("Provide --password or --password-stdin.");
      const context = await getContext(login);
      const startedAt = Date.now();
      const result = await context.api.authApi.login({ username: options.username, password });
      if (!result.token) throw new Error("Login response did not include a token.");
      await saveEasyConsoleConfig({ apiBaseUrl: context.config.apiBaseUrl, token: result.token }, context.config.configPath);
      context.client.setToken(result.token);
      let currentUser: unknown = null;
      try {
        currentUser = await context.api.authApi.userInfo();
      } catch {
        currentUser = null;
      }
      emitSuccess(login, {
        username: options.username,
        configPath: context.config.configPath,
        tokenSaved: true,
        user: currentUser,
      });
      await appendRunLog(context.runLogStorage, {
        channel: "cli",
        source: "auth",
        level: "info",
        action: "login",
        result: "success",
        title: "CLI 登录成功",
        userName: options.username,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      emitFailure(login, error);
    }
  });

  const whoami = program.command("whoami").description("Show current authenticated user");
  whoami.action(run(whoami, (context) => userInfo(context.api)));

  const task = program.command("task").description("Task operations");
  const taskList = task.command("list").description("List tasks");
  taskList.option("--page <number>", "Page", "1");
  taskList.option("--page-size <number>", "Page size", "500");
  taskList.option("--keyword <keyword>", "Keyword");
  taskList.option("--name <name>", "Task name");
  taskList.option("--status <status>", "Task status");
  taskList.action(
    run(taskList, (context) => {
      const options = taskList.opts<{ page: string; pageSize: string; keyword?: string; name?: string; status?: string }>();
      const query: TaskQuery = {
        page: parseInteger(options.page),
        page_size: parseInteger(options.pageSize),
        keyword: options.keyword,
        name: options.name,
        status: options.status,
      };
      return listTasks(context.api, query);
    }),
  );

  const taskLog = task.command("log").description("Read a task log");
  taskLog.argument("<taskId>", "Task id");
  taskLog.option("--limit-bytes <number>", "Maximum bytes to return", String(200_000));
  taskLog.action((taskId: string) =>
    run(taskLog, (context) => {
      const options = taskLog.opts<{ limitBytes: string }>();
      return getTaskLog(context.api, parseId(taskId), parseInteger(options.limitBytes));
    })(),
  );

  const taskCreate = task.command("create").description("Create a task");
  taskCreate.option("--payload-json <json>", "Raw create task JSON payload");
  taskCreate.option("--name <name>", "Task name");
  taskCreate.option("--image-id <id>", "Image id, mapped to backend field img");
  taskCreate.option("--price <number>", "Price");
  taskCreate.option("--cpu <number>", "CPU count");
  taskCreate.option("--gpu <number>", "GPU count");
  taskCreate.option("--memory <number>", "Memory GiB");
  taskCreate.option("--storage-path <path>", "Storage path");
  taskCreate.option("--mount-path <path>", "Mount path");
  taskCreate.option("--release-condition <number>", "Backend releace_conditions value");
  taskCreate.option("--release-time <datetime>", "Release time");
  taskCreate.option("--work-directory <path>", "Work directory");
  taskCreate.option("--script-path <path>", "Script path");
  taskCreate.option("--yes", "Execute instead of dry-run");
  taskCreate.action(
    run(taskCreate, (context) => {
      const options = taskCreate.opts<UnknownRecord & { yes?: boolean }>();
      return createTask(context.api, buildPayloadFromOptions(options), options.yes);
    }),
  );

  const taskRelease = task.command("release").description("Release a task");
  taskRelease.argument("<taskId>", "Task id");
  taskRelease.option("--yes", "Execute instead of dry-run");
  taskRelease.action((taskId: string) =>
    run(taskRelease, (context) => {
      const options = taskRelease.opts<{ yes?: boolean }>();
      return releaseTask(context.api, parseId(taskId), options.yes);
    })(),
  );

  const taskReleaseBatch = task.command("release-batch").description("Release multiple tasks");
  taskReleaseBatch.argument("<ids>", "Comma-separated task ids");
  taskReleaseBatch.option("--yes", "Execute instead of dry-run");
  taskReleaseBatch.action((ids: string) =>
    run(taskReleaseBatch, (context) => {
      const options = taskReleaseBatch.opts<{ yes?: boolean }>();
      const taskIds = ids.split(",").map((id) => parseId(id.trim())).filter(Boolean);
      if (taskIds.length === 0) throw new Error("Provide at least one task id.");
      return releaseTasks(context.api, taskIds, options.yes);
    })(),
  );

  const taskDelete = task.command("delete").description("Delete a task");
  taskDelete.argument("<taskId>", "Task id");
  taskDelete.option("--yes", "Execute instead of dry-run");
  taskDelete.action((taskId: string) =>
    run(taskDelete, (context) => {
      const options = taskDelete.opts<{ yes?: boolean }>();
      return deleteTask(context.api, parseId(taskId), options.yes);
    })(),
  );

  const taskUpdate = task.command("update").description("Update a task");
  taskUpdate.argument("<taskId>", "Task id");
  taskUpdate.option("--payload-json <json>", "Raw update task JSON payload");
  taskUpdate.option("--name <name>", "Task name");
  taskUpdate.option("--image-id <id>", "Image id, mapped to backend field img");
  taskUpdate.option("--price <number>", "Price");
  taskUpdate.option("--cpu <number>", "CPU count");
  taskUpdate.option("--gpu <number>", "GPU count");
  taskUpdate.option("--memory <number>", "Memory GiB");
  taskUpdate.option("--storage-path <path>", "Storage path");
  taskUpdate.option("--mount-path <path>", "Mount path");
  taskUpdate.option("--release-condition <number>", "Backend releace_conditions value");
  taskUpdate.option("--release-time <datetime>", "Release time");
  taskUpdate.option("--work-directory <path>", "Work directory");
  taskUpdate.option("--script-path <path>", "Script path");
  taskUpdate.option("--yes", "Execute instead of dry-run");
  taskUpdate.action((taskId: string) =>
    run(taskUpdate, (context) => {
      const options = taskUpdate.opts<UnknownRecord & { yes?: boolean }>();
      const payload = options.payloadJson
        ? buildCreateTaskPayload(parseJsonRecord(options.payloadJson as string))
        : buildCreateTaskPayload(
            compactRecord({
              name: options.name,
              price: parseNumber(options.price as string | undefined),
              cpu: parseNumber(options.cpu as string | undefined),
              gpu: parseInteger(options.gpu as string | undefined),
              memory: parseInteger(options.memory as string | undefined),
              img: typeof options.imageId === "string" ? parseId(options.imageId) : undefined,
              storage_path: options.storagePath,
              mount_path: options.mountPath,
              releace_conditions: parseInteger(options.releaseCondition as string | undefined),
              releace_time: options.releaseTime,
              work_directory: options.workDirectory,
              script_path: options.scriptPath,
            }),
          );
      return updateTask(context.api, parseId(taskId), payload, options.yes);
    })(),
  );

  const taskDeleteBatch = task.command("delete-batch").description("Delete multiple tasks");
  taskDeleteBatch.argument("<ids>", "Comma-separated task ids");
  taskDeleteBatch.option("--yes", "Execute instead of dry-run");
  taskDeleteBatch.action((ids: string) =>
    run(taskDeleteBatch, (context) => {
      const options = taskDeleteBatch.opts<{ yes?: boolean }>();
      const taskIds = ids.split(",").map((id) => parseId(id.trim())).filter(Boolean);
      if (taskIds.length === 0) throw new Error("Provide at least one task id.");
      return deleteTasks(context.api, taskIds, options.yes);
    })(),
  );

  const taskCheckName = task.command("check-name").description("Check if a task name is available");
  taskCheckName.argument("<name>", "Task name");
  taskCheckName.action((name: string) => run(taskCheckName, (context) => checkTaskName(context.api, name))());

  const taskDownload = task.command("download").description("Download task data");
  taskDownload.argument("<taskId>", "Task id");
  taskDownload.option("--output <path>", "Local output path");
  taskDownload.action((taskId: string) =>
    run(taskDownload, (context) => {
      const options = taskDownload.opts<{ output?: string }>();
      return downloadTask(context.api, { task_id: parseId(taskId) }, options.output);
    })(),
  );

  const storage = program.command("storage").description("Storage operations");
  const storageList = storage.command("ls").description("List remote storage path");
  storageList.argument("[path]", "Remote path", "/");
  storageList.action((path: string) => run(storageList, (context) => listStorage(context.api, path))());

  const storageCat = storage.command("cat").description("Read remote text file");
  storageCat.argument("<path>", "Remote file path");
  storageCat.option("--limit-bytes <number>", "Maximum bytes to return", String(200_000));
  storageCat.action((path: string) =>
    run(storageCat, (context) => {
      const options = storageCat.opts<{ limitBytes: string }>();
      return readStorageText(context.api, path, parseInteger(options.limitBytes));
    })(),
  );

  const storageDownload = storage.command("download").description("Download remote file or path");
  storageDownload.argument("<path>", "Remote path");
  storageDownload.option("--output <path>", "Local output path");
  storageDownload.action((path: string) =>
    run(storageDownload, (context) => {
      const options = storageDownload.opts<{ output?: string }>();
      return downloadStoragePath(context.api, path, options.output);
    })(),
  );

  const storageMkdir = storage.command("mkdir").description("Create remote directory");
  storageMkdir.argument("<path>", "Remote directory");
  storageMkdir.option("--yes", "Execute instead of dry-run");
  storageMkdir.action((path: string) =>
    run(storageMkdir, (context) => {
      const options = storageMkdir.opts<{ yes?: boolean }>();
      return mkdirStorage(context.api, path, options.yes);
    })(),
  );

  const storageDelete = storage.command("delete").description("Delete remote file or directory");
  storageDelete.argument("<path>", "Remote path");
  storageDelete.option("--yes", "Execute instead of dry-run");
  storageDelete.action((path: string) =>
    run(storageDelete, (context) => {
      const options = storageDelete.opts<{ yes?: boolean }>();
      return deleteStoragePath(context.api, path, options.yes);
    })(),
  );

  const storageUpload = storage.command("upload").description("Upload a local file to remote directory");
  storageUpload.argument("<localPath>", "Local file path");
  storageUpload.argument("<remoteDir>", "Remote directory");
  storageUpload.option("--yes", "Execute instead of dry-run");
  storageUpload.action((localPath: string, remoteDir: string) =>
    run(storageUpload, (context) => {
      const options = storageUpload.opts<{ yes?: boolean }>();
      return uploadLocalFile(context.api, localPath, remoteDir, options.yes);
    })(),
  );

  const storageInfo = storage.command("info").description("Show remote storage info");
  storageInfo.action(run(storageInfo, (context) => getStorageInfo(context.api)));

  const image = program.command("image").description("Image operations");
  const imageList = image.command("list").description("List images");
  imageList.action(run(imageList, (context) => listImages(context.api)));
  const imageSetDefault = image.command("set-default").description("Set default image");
  imageSetDefault.argument("<imageId>", "Image id");
  imageSetDefault.option("--yes", "Execute instead of dry-run");
  imageSetDefault.action((imageId: string) =>
    run(imageSetDefault, (context) => {
      const options = imageSetDefault.opts<{ yes?: boolean }>();
      return setDefaultImage(context.api, parseId(imageId), options.yes);
    })(),
  );

  const imageSystem = image.command("system").description("List system images");
  imageSystem.action(run(imageSystem, (context) => listSystemImages(context.api)));

  const imageDetail = image.command("detail").description("Show image detail");
  imageDetail.argument("<imageId>", "Image id");
  imageDetail.action((imageId: string) => run(imageDetail, (context) => getImageDetail(context.api, parseId(imageId)))());

  const imageDownload = image.command("download").description("Download an image");
  imageDownload.argument("<imageId>", "Image id");
  imageDownload.option("--output <path>", "Local output path");
  imageDownload.action((imageId: string) =>
    run(imageDownload, (context) => {
      const options = imageDownload.opts<{ output?: string }>();
      return downloadImage(context.api, parseId(imageId), options.output);
    })(),
  );

  const imageCommit = image.command("commit").description("Commit an image from a task pod");
  imageCommit.option("--payload-json <json>", "Raw commit image JSON payload");
  imageCommit.option("--pod-name <name>", "Pod name");
  imageCommit.option("--user <user>", "User (string or object JSON)");
  imageCommit.option("--yes", "Execute instead of dry-run");
  imageCommit.action(
    run(imageCommit, (context) => {
      const options = imageCommit.opts<{ payloadJson?: string; podName?: string; user?: string; yes?: boolean }>();
      let payload: ImageCommitPayload;
      if (options.payloadJson) {
        payload = parseJsonRecord(options.payloadJson) as unknown as ImageCommitPayload;
      } else {
        if (!options.podName || !options.user) throw new Error("Provide --payload-json or both --pod-name and --user.");
        let user: UnknownRecord | string;
        try {
          user = JSON.parse(options.user) as UnknownRecord;
        } catch {
          user = options.user;
        }
        payload = { user, pod_name: options.podName };
      }
      return commitImage(context.api, payload, options.yes);
    }),
  );

  const resource = program.command("resource").description("Resource operations");
  const resourceList = resource.command("list").description("List resource specs");
  resourceList.action(run(resourceList, (context) => listResources(context.api)));

  const price = program.command("price").description("Price operations");
  const priceList = price.command("list").description("List prices");
  priceList.action(run(priceList, (context) => listPrices(context.api)));

  const monitor = program.command("monitor-url").description("Build a monitor dashboard URL for a task");
  monitor.argument("<taskId>", "Task id");
  monitor.action((taskId: string) => run(monitor, (context) => monitorUrl(context.api, parseId(taskId)))());

  const dashboard = program.command("dashboard").description("Dashboard statistics operations");
  const dashboardStats = dashboard.command("stats").description("Get dashboard statistics");
  dashboardStats.option("--query-json <json>", "Raw query JSON");
  dashboardStats.action(
    run(dashboardStats, (context) => {
      const options = dashboardStats.opts<{ queryJson?: string }>();
      const query = options.queryJson ? parseJsonRecord(options.queryJson) : undefined;
      return getDashboardStats(context.api, query);
    }),
  );

  const dashboardCost = dashboard.command("cost").description("Get dashboard cost statistics");
  dashboardCost.option("--query-json <json>", "Raw query JSON");
  dashboardCost.action(
    run(dashboardCost, (context) => {
      const options = dashboardCost.opts<{ queryJson?: string }>();
      const query = options.queryJson ? parseJsonRecord(options.queryJson) : undefined;
      return getDashboardCost(context.api, query);
    }),
  );

  const dashboardCostMonth = dashboard.command("cost-month").description("Get dashboard monthly cost");
  dashboardCostMonth.action(run(dashboardCostMonth, (context) => getDashboardCostMonth(context.api)));

  const dashboardMonitorIndex = dashboard.command("monitor-index").description("Get monitor index data");
  dashboardMonitorIndex.option("--query-json <json>", "Raw query JSON");
  dashboardMonitorIndex.action(
    run(dashboardMonitorIndex, (context) => {
      const options = dashboardMonitorIndex.opts<{ queryJson?: string }>();
      const query = options.queryJson ? parseJsonRecord(options.queryJson) : undefined;
      return getMonitorIndex(context.api, query);
    }),
  );

  const account = program.command("account").description("Account operations");
  const accountChangePassword = account.command("change-password").description("Change account password");
  accountChangePassword.option("--payload-json <json>", "Raw change password JSON payload");
  accountChangePassword.option("--old <password>", "Old password");
  accountChangePassword.option("--new <password>", "New password");
  accountChangePassword.option("--yes", "Execute instead of dry-run");
  accountChangePassword.action(
    run(accountChangePassword, (context) => {
      const options = accountChangePassword.opts<{ payloadJson?: string; old?: string; new?: string; yes?: boolean }>();
      const payload = options.payloadJson
        ? parseJsonRecord(options.payloadJson)
        : compactRecord({ old_password: options.old, new_password: options.new });
      if (Object.keys(payload).length === 0) throw new Error("Provide --payload-json or both --old and --new.");
      return changePassword(context.api, payload, options.yes);
    }),
  );

  const accountRefresh = account.command("refresh-token").description("Refresh the current auth token");
  accountRefresh.action(
    run(accountRefresh, async (context) => {
      if (!context.config.token) throw new Error("No current token found in config.");
      const result = await refreshToken(context.api, context.config.token);
      if (result.token) {
        await saveEasyConsoleConfig({ apiBaseUrl: context.config.apiBaseUrl, token: result.token }, context.config.configPath);
        context.client.setToken(result.token);
      }
      return result;
    }),
  );

  const template = program.command("template").description("Local task template operations");
  const templateList = template.command("list").description("List local task templates");
  templateList.action(run(templateList, (context) => listTaskTemplates(context.storage)));

  const templateCreate = template.command("create").description("Create a local task template");
  templateCreate.requiredOption("--template-json <json>", "Editable task template JSON");
  templateCreate.option("--yes", "Execute instead of dry-run");
  templateCreate.action(
    run(templateCreate, (context) => {
      const options = templateCreate.opts<{ templateJson: string; yes?: boolean }>();
      const input = parseJsonRecord(options.templateJson) as unknown as EditableTaskTemplate;
      return createTaskTemplateRecord(context.storage, input, options.yes);
    }),
  );

  const templateUpdate = template.command("update").description("Update a local task template");
  templateUpdate.argument("<templateId>", "Template id");
  templateUpdate.requiredOption("--template-json <json>", "Editable task template JSON");
  templateUpdate.option("--yes", "Execute instead of dry-run");
  templateUpdate.action((templateId: string) =>
    run(templateUpdate, (context) => {
      const options = templateUpdate.opts<{ templateJson: string; yes?: boolean }>();
      const input = parseJsonRecord(options.templateJson) as unknown as EditableTaskTemplate;
      return updateTaskTemplateRecord(context.storage, templateId, input, options.yes);
    })(),
  );

  const templateApply = template.command("apply").description("Apply a task template to create tasks");
  templateApply.argument("<templateId>", "Template id");
  templateApply.option("--variables-json <json>", "Template variable values JSON object");
  templateApply.option("--yes", "Execute instead of dry-run");
  templateApply.action((templateId: string) =>
    run(templateApply, (context) => {
      const options = templateApply.opts<{ yes?: boolean; variablesJson?: string }>();
      const variableValues = options.variablesJson
        ? (parseJsonRecord(options.variablesJson) as Record<string, string>)
        : undefined;
      return applyTaskTemplate(context.storage, context.api, templateId, options.yes, variableValues);
    })(),
  );

  const templateDelete = template.command("delete").description("Delete a local task template");
  templateDelete.argument("<templateId>", "Template id");
  templateDelete.option("--yes", "Execute instead of dry-run");
  templateDelete.action((templateId: string) =>
    run(templateDelete, (context) => {
      const options = templateDelete.opts<{ yes?: boolean }>();
      return deleteTaskTemplate(context.storage, templateId, options.yes);
    })(),
  );

  const schedule = program.command("schedule").description("Local scheduled task operations");
  const scheduleList = schedule.command("list").description("List local scheduled tasks");
  scheduleList.action(run(scheduleList, (context) => listScheduledTasks(context.storage)));

  const scheduleCreate = schedule.command("create").description("Create a local scheduled task");
  scheduleCreate.requiredOption("--name <name>", "Scheduled task name");
  scheduleCreate.requiredOption("--schedule-time <datetime>", "ISO schedule time");
  scheduleCreate.requiredOption("--payload-json <json>", "Create task JSON payload");
  scheduleCreate.option("--description <text>", "Description");
  scheduleCreate.option("--recurrence-json <json>", "Recurrence JSON");
  scheduleCreate.option("--yes", "Execute instead of dry-run");
  scheduleCreate.action(
    run(scheduleCreate, async (context) => {
      const options = scheduleCreate.opts<{
        name: string;
        scheduleTime: string;
        payloadJson: string;
        description?: string;
        recurrenceJson?: string;
        yes?: boolean;
      }>();
      const payload = buildCreateTaskPayload(parseJsonRecord(options.payloadJson));
      const recurrence = options.recurrenceJson ? (JSON.parse(options.recurrenceJson) as TaskRecurrence) : undefined;
      return createScheduledTaskRecord(
        context.storage,
        {
          name: options.name,
          description: options.description,
          scheduleTime: options.scheduleTime,
          payload,
          recurrence,
        },
        options.yes,
      );
    }),
  );

  const scheduleUpdate = schedule.command("update").description("Update a local scheduled task");
  scheduleUpdate.argument("<taskId>", "Scheduled task id");
  scheduleUpdate.requiredOption("--schedule-json <json>", "Partial scheduled task JSON (name/description/scheduleTime/payload/recurrence)");
  scheduleUpdate.option("--yes", "Execute instead of dry-run");
  scheduleUpdate.action((taskId: string) =>
    run(scheduleUpdate, (context) => {
      const options = scheduleUpdate.opts<{ scheduleJson: string; yes?: boolean }>();
      const patch = parseJsonRecord(options.scheduleJson);
      if (patch.payload && typeof patch.payload === "object") {
        patch.payload = buildCreateTaskPayload(patch.payload as UnknownRecord);
      }
      return updateScheduledTaskRecord(context.storage, taskId, patch as Parameters<typeof updateScheduledTaskRecord>[2], options.yes);
    })(),
  );

  const schedulePause = schedule.command("pause").description("Pause a pending scheduled task");
  schedulePause.argument("<taskId>", "Scheduled task id");
  schedulePause.option("--yes", "Execute instead of dry-run");
  schedulePause.action((taskId: string) =>
    run(schedulePause, (context) => {
      const options = schedulePause.opts<{ yes?: boolean }>();
      return pauseScheduledTaskRecord(context.storage, taskId, options.yes);
    })(),
  );

  const scheduleResume = schedule.command("resume").description("Resume a paused or failed scheduled task");
  scheduleResume.argument("<taskId>", "Scheduled task id");
  scheduleResume.option("--yes", "Execute instead of dry-run");
  scheduleResume.action((taskId: string) =>
    run(scheduleResume, (context) => {
      const options = scheduleResume.opts<{ yes?: boolean }>();
      return resumeScheduledTaskRecord(context.storage, taskId, options.yes);
    })(),
  );

  const scheduleRun = schedule.command("run").description("Manually run a scheduled task now");
  scheduleRun.argument("<taskId>", "Scheduled task id");
  scheduleRun.option("--yes", "Execute instead of dry-run");
  scheduleRun.action((taskId: string) =>
    run(scheduleRun, (context) => {
      const options = scheduleRun.opts<{ yes?: boolean }>();
      return runScheduledTask(context.storage, context.api, taskId, options.yes);
    })(),
  );

  const scheduleDelete = schedule.command("delete").description("Delete a local scheduled task");
  scheduleDelete.argument("<taskId>", "Scheduled task id");
  scheduleDelete.option("--yes", "Execute instead of dry-run");
  scheduleDelete.action((taskId: string) =>
    run(scheduleDelete, (context) => {
      const options = scheduleDelete.opts<{ yes?: boolean }>();
      return deleteScheduledTask(context.storage, taskId, options.yes);
    })(),
  );

  const backup = program.command("backup").description("Local data backup operations");
  const backupExport = backup.command("export").description("Export local data as backup JSON");
  backupExport.option("--include-secrets", "Include token and saved accounts in the backup");
  backupExport.action(
    run(backupExport, (context) => {
      const options = backupExport.opts<{ includeSecrets?: boolean }>();
      return exportBackup(context.storage, Boolean(options.includeSecrets));
    }),
  );

  const backupImport = backup.command("import").description("Import local data from a backup file");
  backupImport.argument("<file>", "Backup JSON file path");
  backupImport.option("--sections <sections>", "Comma-separated sections to import (default: all non-secret)");
  backupImport.option("--yes", "Execute instead of dry-run");
  backupImport.action((file: string) =>
    run(backupImport, async (context) => {
      const options = backupImport.opts<{ sections?: string; yes?: boolean }>();
      const { readFile } = await import("node:fs/promises");
      const backupText = await readFile(file, "utf8");
      const sections: LocalDataBackupSection[] = options.sections
        ? (options.sections.split(",").map((s) => s.trim()).filter(Boolean) as LocalDataBackupSection[])
        : [...nonSecretBackupSections, ...secretBackupSections];
      return importBackup(context.storage, backupText, sections, options.yes);
    })(),
  );

  const runLog = program.command("run-log").description("Local EasyConsole run log operations");
  const runLogList = runLog.command("list").description("List local run logs");
  runLogList.option("--limit <number>", "Maximum entries", "100");
  runLogList.option("--source <source>", "Filter by source");
  runLogList.option("--channel <channel>", "Filter by channel");
  runLogList.option("--result <result>", "Filter by result");
  runLogList.option("--keyword <keyword>", "Keyword filter");
  runLogList.action(
    run(runLogList, async (context) => {
      const options = runLogList.opts<{ limit?: string; source?: RunLogSource; channel?: RunLogChannel; result?: RunLogResult; keyword?: string }>();
      const logs = await loadRunLogs(context.runLogStorage);
      return filterRunLogs(logs, {
        limit: parseInteger(options.limit),
        source: options.source,
        channel: options.channel,
        result: options.result,
        keyword: options.keyword,
      });
    }),
  );

  const runLogExport = runLog.command("export").description("Export local run logs as JSON text");
  runLogExport.action(run(runLogExport, async (context) => JSON.parse(formatRunLogExport(await loadRunLogs(context.runLogStorage)))));

  const runLogClear = runLog.command("clear").description("Clear local run logs");
  runLogClear.option("--yes", "Execute instead of dry-run");
  runLogClear.action(
    run(runLogClear, async (context) => {
      const options = runLogClear.opts<{ yes?: boolean }>();
      if (!options.yes) return { dryRun: true, action: "run-log.clear", message: "Pass --yes to clear local run logs." };
      await clearRunLogs(context.runLogStorage);
      return { dryRun: false, action: "run-log.clear", cleared: true };
    }),
  );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      exitCode = error.exitCode;
      if (error.code !== "commander.helpDisplayed" && error.message) stderr += `${error.message}\n`;
    } else {
      exitCode = 1;
      stderr += `${formatError(error).message}\n`;
    }
  }

  return { exitCode, stdout, stderr };
}
