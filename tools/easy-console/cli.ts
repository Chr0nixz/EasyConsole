import { Command, CommanderError } from "commander";

import type { CreateTaskPayload, TaskQuery, UnknownRecord } from "../../src/lib/types";
import { saveEasyConsoleConfig } from "./config";
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
  json?: boolean;
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
    });
  }

  function run(command: Command, handler: (context: EasyConsoleContext) => Promise<unknown>) {
    return async () => {
      try {
        emitSuccess(command, await handler(await getContext(command)));
      } catch (error) {
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

  const taskDelete = task.command("delete").description("Delete a task");
  taskDelete.argument("<taskId>", "Task id");
  taskDelete.option("--yes", "Execute instead of dry-run");
  taskDelete.action((taskId: string) =>
    run(taskDelete, (context) => {
      const options = taskDelete.opts<{ yes?: boolean }>();
      return deleteTask(context.api, parseId(taskId), options.yes);
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

  const resource = program.command("resource").description("Resource operations");
  const resourceList = resource.command("list").description("List resource specs");
  resourceList.action(run(resourceList, (context) => listResources(context.api)));

  const price = program.command("price").description("Price operations");
  const priceList = price.command("list").description("List prices");
  priceList.action(run(priceList, (context) => listPrices(context.api)));

  const monitor = program.command("monitor-url").description("Build a monitor dashboard URL for a task");
  monitor.argument("<taskId>", "Task id");
  monitor.action((taskId: string) => run(monitor, (context) => monitorUrl(context.api, parseId(taskId)))());

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
