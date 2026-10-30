import { lstatSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { buildMonitorDashboardUrl, DEFAULT_MONITOR_DASHBOARD_URL } from "../../src/lib/monitor-dashboard-core";
import type { EasyConsoleApi } from "../../src/lib/api-factory";
import type { AccountScope } from "../../src/lib/account-scope";
import { runBatch, type BatchItemOutcome } from "../../src/lib/batch-runner";
import { fetchAllTasks } from "../../src/lib/fetch-all-tasks";
import { getStatusText } from "../../src/lib/format";
import { i18nText } from "../../src/lib/i18n-text";
import { exportLocalDataBackup, importLocalDataBackup, parseLocalDataBackup, type LocalDataBackupSection } from "../../src/lib/local-data-backup";
import { normalizeStoragePath } from "../../src/lib/remote-storage";
import { appendRunLog, type RunLogChannel } from "../../src/lib/run-logs";
import { createScheduledTask, loadScheduledTasks, pauseScheduledTask, resumeScheduledTask, saveScheduledTasks, updateScheduledTask } from "../../src/lib/scheduled-tasks";
import { executeScheduledTask } from "../../src/lib/schedule-execution";
import { buildTaskSshInfo } from "../../src/lib/ssh-info";
import { FAILURE_STATUSES } from "../../src/lib/task-status-notifications";
import { withStorageTransaction } from "../../src/lib/storage-mutex";
import {
  createTaskTemplate,
  loadTaskTemplates,
  recordTaskTemplateUsage,
  saveTaskTemplates,
  taskTemplateToPayloads,
  updateTaskTemplate,
  type EditableTaskTemplate,
} from "../../src/lib/task-templates";
import type {
  CreateTaskPayload,
  ImageCommitPayload,
  RuntimeStorage,
  ScheduledTask,
  Task,
  TaskQuery,
  TaskRecurrence,
  UnknownRecord,
} from "../../src/lib/types";

export const DEFAULT_TEXT_LIMIT_BYTES = 200_000;

export type TruncatedText = {
  text: string;
  bytes: number;
  limitBytes: number;
  truncated: boolean;
};

export type ConfirmedMutationResult = {
  dryRun: false;
  action: string;
  payload: unknown;
  result: unknown;
  /**
   * Caveat the caller must know about, e.g. that a persisted local scheduled
   * task is never executed automatically. Optional so existing results are
   * unaffected.
   */
  note?: string;
};

export type DryRunMutationResult = {
  dryRun: true;
  action: string;
  payload: unknown;
  message: string;
  /** Structured preview of what the mutation would touch, when the operation supports one. */
  impact?: BatchImpactItem[];
};

export type MutationResult = ConfirmedMutationResult | DryRunMutationResult;

/** One entry of a batch dry-run preview: which object the batch would touch. */
export type BatchImpactItem = {
  id: string | number;
  name: string;
};

/** Per-item receipt of an executed batch: one entry per input item, failures included. */
export type BatchItemReceipt = {
  id: string | number;
  name: string;
  ok: boolean;
  error?: string;
};

/** Where per-item batch run logs are written; the channel distinguishes CLI from MCP callers. */
export type BatchRunLogSink = {
  storage: RuntimeStorage;
  channel: RunLogChannel;
};

export type MaybeMutateOptions = {
  impact?: BatchImpactItem[];
};

function taskIdMatches(task: Task, taskId: string | number) {
  const expected = String(taskId);
  return String(task.id) === expected || String(task.task_id ?? "") === expected;
}

function getMonitorDashboardBaseUrl() {
  return process.env.EASY_CONSOLE_MONITOR_DASHBOARD_URL ?? process.env.VITE_MONITOR_DASHBOARD_URL ?? DEFAULT_MONITOR_DASHBOARD_URL;
}

export function truncateText(text: string, limitBytes = DEFAULT_TEXT_LIMIT_BYTES): TruncatedText {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= limitBytes) {
    return { text, bytes: bytes.length, limitBytes, truncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.slice(0, limitBytes)),
    bytes: bytes.length,
    limitBytes,
    truncated: true,
  };
}

export async function blobToText(blob: Blob, limitBytes = DEFAULT_TEXT_LIMIT_BYTES) {
  return truncateText(await blob.text(), limitBytes);
}

/**
 * Root that downloads are confined to.
 *
 * Writing to disk is a real side effect, but the download operations are
 * reachable as read-only MCP tools, so an unconstrained `outputPath` would let
 * a misled agent drop remote-controlled bytes onto `~/.bashrc`, an autostart
 * entry, or an existing executable. Callers that genuinely need another
 * location set `EASY_CONSOLE_DOWNLOAD_DIR`.
 */
export function getDownloadRoot() {
  return resolve(process.env.EASY_CONSOLE_DOWNLOAD_DIR ?? join(homedir(), ".easy-console", "downloads"));
}

export type WriteBlobOptions = {
  overwrite?: boolean;
  /**
   * Allow writing outside the download root.
   *
   * Set by the CLI, where `--output` is an explicit human instruction (same
   * expectation as `curl -o`). Never set from MCP: there the path may originate
   * from model output influenced by remote content.
   */
  allowOutsideRoot?: boolean;
};

function assertInsideDirectory(root: string, candidate: string) {
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`Refusing to write outside the download directory (${root}). Got: ${candidate}`);
  }
}

/**
 * Rejects symlink/junction segments below the download root, including the
 * final path component. On Windows a junction reports `isSymbolicLink()` from
 * `lstat` just like a symlink does on POSIX, and either kind can point outside
 * the root, so the lexical prefix check alone is not enough. Segments that do
 * not exist yet are fine: `writeBlobToFile` creates them fresh.
 */
function assertNoLinkSegmentsBelowRoot(root: string, target: string) {
  let cursor = root;
  for (const segment of target.slice(root.length).split(sep)) {
    if (!segment) continue;
    cursor = join(cursor, segment);
    let info: Stats;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The segment does not exist (ENOENT, or ENOTDIR when a parent is a
      // plain file): it cannot be a link, and `writeBlobToFile` creates what
      // is missing fresh. Anything else is unreadable, so the write is
      // refused rather than proceeding unverified.
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlink or junction below the download directory: ${cursor}`);
    }
  }
}

/**
 * Compares canonical filesystem paths so aliases the lexical check cannot see
 * (pre-existing junctions, 8.3 short names, casing) still cannot escape the
 * download root. When the target does not exist, the deepest existing ancestor
 * is checked instead. Unexpected filesystem errors fail closed: if the real
 * location cannot be determined, the write is refused.
 */
function assertRealPathInsideRoot(root: string, target: string) {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // The root does not exist yet; it gets created fresh below segments the
    // link walk above already vetted, so the lexical root is canonical.
    return;
  }
  let probe = target;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOENT" || code === "ENOTDIR") && probe !== root) {
        probe = dirname(probe);
        continue;
      }
      throw error;
    }
    assertInsideDirectory(realRoot, real);
    return;
  }
}

function resolveDownloadPath(outputPath: string, allowOutsideRoot: boolean) {
  if (allowOutsideRoot) return resolve(outputPath);

  const root = getDownloadRoot();
  // Relative paths resolve against the root rather than the process cwd, so a
  // bare `report.json` stays inside it.
  const resolvedPath = isAbsolute(outputPath) ? resolve(outputPath) : resolve(root, outputPath);
  assertInsideDirectory(root, resolvedPath);
  assertNoLinkSegmentsBelowRoot(root, resolvedPath);
  assertRealPathInsideRoot(root, resolvedPath);
  return resolvedPath;
}

export async function writeBlobToFile(blob: Blob, outputPath: string, options: WriteBlobOptions = {}) {
  const resolvedPath = resolveDownloadPath(outputPath, options.allowOutsideRoot === true);
  await mkdir(dirname(resolvedPath), { recursive: true });
  if (!options.overwrite) {
    const exists = await stat(resolvedPath).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Error(`Refusing to overwrite an existing file: ${resolvedPath}. Pass overwrite to replace it.`);
    }
  }
  await writeFile(resolvedPath, Buffer.from(await blob.arrayBuffer()));
  return {
    path: resolvedPath,
    bytes: blob.size,
  };
}

export async function maybeMutate(
  action: string,
  payload: unknown,
  confirm: boolean | undefined,
  run: () => Promise<unknown>,
  options: MaybeMutateOptions = {},
): Promise<MutationResult> {
  if (!confirm) {
    return {
      dryRun: true,
      action,
      payload,
      message: "Pass confirm=true or --yes to execute this mutation.",
      ...(options.impact ? { impact: options.impact } : {}),
    };
  }
  return {
    dryRun: false,
    action,
    payload,
    result: await run(),
  };
}

export function buildCreateTaskPayload(input: UnknownRecord): CreateTaskPayload {
  const payload = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as CreateTaskPayload;
  if (!payload.name || typeof payload.name !== "string") {
    throw new Error("Task create payload requires a non-empty name.");
  }
  return payload;
}

export async function listTasks(api: EasyConsoleApi, query: TaskQuery) {
  return api.instanceApi.tasks(query);
}

/** Backend task status for a running instance. */
const RUNNING_TASK_STATUS = 2;

async function findTaskById(api: EasyConsoleApi, taskId: string | number): Promise<Task> {
  const tasks = await api.instanceApi.tasks({ page: 1, page_size: 500 });
  const task = tasks.items.find((item) => taskIdMatches(item, taskId));
  if (!task) {
    throw new Error(i18nText(`未找到任务 ${taskId}`, `Task ${taskId} not found`));
  }
  return task;
}

function sleep(ms: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * One task by id (or `task_id`) enriched for agents: where to SSH and where to
 * monitor. SSH credentials are deliberately omitted — agents learn where to
 * connect, not the secret.
 */
export async function getTask(api: EasyConsoleApi, taskId: string | number) {
  const task = await findTaskById(api, taskId);
  const ssh = buildTaskSshInfo(task);
  return {
    task,
    statusText: getStatusText(task.status),
    ssh: { host: ssh.host, port: ssh.port, username: ssh.username, passwordKind: ssh.passwordKind },
    monitorUrl: buildMonitorDashboardUrl(task, getMonitorDashboardBaseUrl()),
  };
}

export type WaitForTaskOutcome = "target" | "failed" | "timeout";

export type WaitForTaskResult = {
  task: Task;
  outcome: WaitForTaskOutcome;
  status: number;
  statusText: string;
  elapsedMs: number;
};

/**
 * Poll a task until it reaches a target status, enters a failure state, or the
 * timeout elapses. Failure statuses (7 failed / 8 abnormal) return early with
 * `outcome: "failed"` instead of burning the whole timeout.
 */
export async function waitForTask(
  api: EasyConsoleApi,
  taskId: string | number,
  options: { targetStatuses?: number[]; timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<WaitForTaskResult> {
  const targetStatuses = options.targetStatuses ?? [RUNNING_TASK_STATUS];
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  for (;;) {
    options.signal?.throwIfAborted();
    const task = await findTaskById(api, taskId);
    const status = Number(task.status);
    if (targetStatuses.includes(status)) {
      return { task, outcome: "target", status, statusText: getStatusText(task.status), elapsedMs: Date.now() - startedAt };
    }
    if (FAILURE_STATUSES.has(status)) {
      return { task, outcome: "failed", status, statusText: getStatusText(task.status), elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() >= deadline) {
      return { task, outcome: "timeout", status, statusText: getStatusText(task.status), elapsedMs: Date.now() - startedAt };
    }
    await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
  }
}

export async function getTaskLog(api: EasyConsoleApi, taskId: string | number, limitBytes = DEFAULT_TEXT_LIMIT_BYTES) {
  const text = await api.instanceApi.taskLog({ id: taskId });
  return {
    taskId,
    ...truncateText(text, limitBytes),
  };
}

export function createTask(api: EasyConsoleApi, payload: CreateTaskPayload, confirm?: boolean) {
  return maybeMutate("task.create", payload, confirm, () => api.instanceApi.createTask(payload));
}

const BATCH_OPERATION_DELAY_MS = 350;

function createBatchId() {
  return globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function taskDisplayFallback(task: Task | undefined, id: string | number) {
  const name = task?.name ?? task?.task_name ?? task?.description;
  return typeof name === "string" && name.trim() ? name.trim() : `#${id}`;
}

/**
 * Map task ids to display names for batch previews by scanning the task list.
 * Ids the list does not contain (already released, deleted, or paginated out)
 * fall back to an explicit `#id` placeholder, and a failed listing degrades
 * the same way — a preview must never fail or mutate anything.
 */
async function resolveTaskBatchImpact(api: EasyConsoleApi, taskIds: Array<string | number>): Promise<BatchImpactItem[]> {
  let items: Task[] = [];
  try {
    items = (await fetchAllTasks(api.instanceApi)).items;
  } catch {
    items = [];
  }
  return taskIds.map((id) => {
    const task = items.find((item) => taskIdMatches(item, id));
    return { id, name: taskDisplayFallback(task, id) };
  });
}

function toBatchItemReceipts(outcomes: BatchItemOutcome<string | number>[], impact: BatchImpactItem[]): BatchItemReceipt[] {
  const names = new Map(impact.map((item) => [String(item.id), item.name]));
  return outcomes.map((outcome) => ({
    id: outcome.item,
    name: names.get(String(outcome.item)) ?? `#${outcome.item}`,
    ok: outcome.status === "succeeded",
    error: outcome.error,
  }));
}

/**
 * Write one run-log entry per batch item so mixed batches stay auditable at
 * item granularity. Best-effort by design: the remote calls have already
 * happened, so a broken run-log store must not fail the receipt.
 */
async function appendBatchItemRunLogs(
  sink: BatchRunLogSink | undefined,
  input: { action: string; batchId: string; items: BatchItemReceipt[] },
): Promise<void> {
  if (!sink) return;
  for (const item of input.items) {
    try {
      await appendRunLog(sink.storage, {
        channel: sink.channel,
        source: "task",
        level: item.ok ? "info" : "error",
        action: input.action,
        result: item.ok ? "success" : "failure",
        title: item.ok
          ? i18nText(`批量操作成功：${item.name}`, `Batch operation succeeded: ${item.name}`)
          : i18nText(`批量操作失败：${item.name}`, `Batch operation failed: ${item.name}`),
        targetId: item.id,
        targetName: item.name,
        error: item.error,
        metadata: { batchId: input.batchId },
      });
    } catch {
      // Intentional best-effort degradation; the receipts carry the truth.
    }
  }
}

export function releaseTask(api: EasyConsoleApi, taskId: string | number, confirm?: boolean) {
  return maybeMutate("task.release", { id: taskId }, confirm, () => api.instanceApi.operateTask(taskId));
}

export async function releaseTasks(
  api: EasyConsoleApi,
  taskIds: Array<string | number>,
  confirm?: boolean,
  runLog?: BatchRunLogSink,
) {
  const impact = await resolveTaskBatchImpact(api, taskIds);
  return maybeMutate(
    "task.releaseBatch",
    { ids: taskIds },
    confirm,
    async () => {
      const batchId = createBatchId();
      const batch = await runBatch(taskIds, {
        delayMs: BATCH_OPERATION_DELAY_MS,
        run: (taskId) => api.instanceApi.operateTask(taskId),
      });
      const results = toBatchItemReceipts(batch.outcomes, impact);
      await appendBatchItemRunLogs(runLog, { action: "task.releaseBatch", batchId, items: results });
      return { batchId, count: taskIds.length, results };
    },
    { impact },
  );
}

export function deleteTask(api: EasyConsoleApi, taskId: string | number, confirm?: boolean) {
  return maybeMutate("task.delete", { id: taskId }, confirm, () => api.instanceApi.deleteTask(taskId));
}

export async function listStorage(api: EasyConsoleApi, path = "/") {
  return api.storageApi.list({ path: normalizeStoragePath(path) });
}

export async function readStorageText(api: EasyConsoleApi, path: string, limitBytes = DEFAULT_TEXT_LIMIT_BYTES) {
  const normalizedPath = normalizeStoragePath(path);
  const result = await api.storageApi.transmit({ path: normalizedPath });
  if (result instanceof Blob) {
    return {
      path: normalizedPath,
      ...(await blobToText(result, limitBytes)),
    };
  }
  return {
    path: normalizedPath,
    ...truncateText(JSON.stringify(result, null, 2), limitBytes),
  };
}

export async function downloadStoragePath(
  api: EasyConsoleApi,
  path: string,
  outputPath?: string,
  options: WriteBlobOptions = {},
) {
  const normalizedPath = normalizeStoragePath(path);
  const result = await api.storageApi.transmit({ path: normalizedPath });
  const blob = result instanceof Blob ? result : new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const targetPath = outputPath ?? (basename(normalizedPath) || "easy-console-download");
  return {
    remotePath: normalizedPath,
    ...(await writeBlobToFile(blob, targetPath, options)),
  };
}

export function mkdirStorage(api: EasyConsoleApi, path: string, confirm?: boolean) {
  const normalizedPath = normalizeStoragePath(path);
  return maybeMutate("storage.mkdir", { path: normalizedPath }, confirm, () => api.storageApi.mkdir(normalizedPath));
}

export function deleteStoragePath(api: EasyConsoleApi, path: string, confirm?: boolean) {
  const normalizedPath = normalizeStoragePath(path);
  return maybeMutate("storage.delete", { path: normalizedPath }, confirm, () => api.storageApi.delete(normalizedPath));
}

export async function listImages(api: EasyConsoleApi, query?: UnknownRecord) {
  const [custom, system] = await Promise.all([api.imageApi.list(query), api.imageApi.system({})]);
  return {
    custom,
    system,
    items: [...custom.items, ...system.items],
  };
}

export function setDefaultImage(api: EasyConsoleApi, imageId: string | number, confirm?: boolean) {
  return maybeMutate("image.setDefault", { id: imageId }, confirm, () => api.imageApi.setDefault(imageId));
}

export function updateImage(api: EasyConsoleApi, imageId: string | number, payload: UnknownRecord, confirm?: boolean) {
  return maybeMutate("image.update", { id: imageId, payload }, confirm, () => api.imageApi.updateImage(imageId, payload));
}

export function deleteImage(api: EasyConsoleApi, imageId: string | number, confirm?: boolean) {
  return maybeMutate("image.delete", { id: imageId }, confirm, () => api.imageApi.deleteImage(imageId));
}

export function userInfo(api: EasyConsoleApi) {
  return api.authApi.userInfo();
}

export function listResources(api: EasyConsoleApi) {
  return api.resourceApi.resources();
}

export function listPrices(api: EasyConsoleApi) {
  return api.resourceApi.prices();
}

export async function monitorUrl(api: EasyConsoleApi, taskId: string | number) {
  const tasks = await api.instanceApi.tasks({ page: 1, page_size: 500 });
  const task = tasks.items.find((item) => taskIdMatches(item, taskId)) ?? ({ id: taskId } as Task);
  return {
    task,
    url: buildMonitorDashboardUrl(task, getMonitorDashboardBaseUrl()),
  };
}

// === Task extensions ===

export function updateTask(api: EasyConsoleApi, taskId: string | number, payload: Partial<CreateTaskPayload>, confirm?: boolean) {
  return maybeMutate("task.update", { id: taskId, payload }, confirm, () => api.instanceApi.updateTask(taskId, payload));
}

export async function deleteTasks(
  api: EasyConsoleApi,
  taskIds: Array<string | number>,
  confirm?: boolean,
  runLog?: BatchRunLogSink,
) {
  const impact = await resolveTaskBatchImpact(api, taskIds);
  return maybeMutate(
    "task.deleteBatch",
    { ids: taskIds },
    confirm,
    async () => {
      const batchId = createBatchId();
      // Per-item deletes (not the batch endpoint) so one rejected id cannot
      // take the whole batch down with no receipt for the rest.
      const batch = await runBatch(taskIds, {
        delayMs: BATCH_OPERATION_DELAY_MS,
        run: (taskId) => api.instanceApi.deleteTask(taskId),
      });
      const results = toBatchItemReceipts(batch.outcomes, impact);
      await appendBatchItemRunLogs(runLog, { action: "task.deleteBatch", batchId, items: results });
      return { batchId, count: taskIds.length, results };
    },
    { impact },
  );
}

export function checkTaskName(api: EasyConsoleApi, name: string) {
  return api.instanceApi.checkTaskName(name);
}

export async function downloadTask(
  api: EasyConsoleApi,
  query: UnknownRecord,
  outputPath?: string,
  options: WriteBlobOptions = {},
) {
  const blob = await api.instanceApi.downloadTask(query);
  const targetPath = outputPath ?? `task-${Date.now()}.zip`;
  return writeBlobToFile(blob, targetPath, options);
}

// === Dashboard ===

export function getDashboardStats(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.statics(query);
}

export function getDashboardCost(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.staticsCost(query);
}

export function getDashboardCostMonth(api: EasyConsoleApi) {
  return api.instanceApi.staticsCostMonth();
}

export function getMonitorIndex(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.instanceApi.monitorIndex(query);
}

// === Image extensions ===

export function listSystemImages(api: EasyConsoleApi, query?: UnknownRecord) {
  return api.imageApi.system(query);
}

export function getImageDetail(api: EasyConsoleApi, imageId: string | number) {
  return api.imageApi.detail(imageId);
}

export async function downloadImage(
  api: EasyConsoleApi,
  imageId: string | number,
  outputPath?: string,
  options: WriteBlobOptions = {},
) {
  const blob = await api.imageApi.download(imageId);
  const targetPath = outputPath ?? `image-${imageId}.tar`;
  return writeBlobToFile(blob, targetPath, options);
}

export function commitImage(api: EasyConsoleApi, payload: ImageCommitPayload, confirm?: boolean) {
  return maybeMutate("image.commit", payload, confirm, () => api.imageApi.commitImage(payload));
}

// === Storage extensions ===

export async function uploadLocalFile(api: EasyConsoleApi, localPath: string, remoteDirectory: string, confirm?: boolean) {
  const buffer = await readFile(localPath);
  const filename = basename(localPath);
  const file = new File([buffer], filename);
  return maybeMutate("storage.upload", { localPath, remoteDirectory, filename }, confirm, () =>
    api.storageApi.uploadFile(file, normalizeStoragePath(remoteDirectory)),
  );
}

export function getStorageInfo(api: EasyConsoleApi) {
  return api.storageApi.info();
}

// === Account ===

export function changePassword(api: EasyConsoleApi, payload: UnknownRecord, confirm?: boolean) {
  return maybeMutate("account.changePassword", payload, confirm, () => api.authApi.changePassword(payload));
}

export async function refreshToken(api: EasyConsoleApi, currentToken: string) {
  const newToken = await api.authApi.refreshToken(currentToken);
  return { refreshed: Boolean(newToken), token: newToken };
}

// === Local data: Task templates ===

export async function listTaskTemplates(storage: RuntimeStorage) {
  return loadTaskTemplates(storage);
}

export async function createTaskTemplateRecord(storage: RuntimeStorage, input: EditableTaskTemplate, confirm?: boolean) {
  return maybeMutate("template.create", { name: input.name }, confirm, async () =>
    withStorageTransaction(storage, async () => {
      const templates = await loadTaskTemplates(storage);
      const created = createTaskTemplate(input);
      await saveTaskTemplates(storage, [...templates, created]);
      return created;
    }),
  );
}

export async function updateTaskTemplateRecord(
  storage: RuntimeStorage,
  templateId: string,
  input: EditableTaskTemplate,
  confirm?: boolean,
) {
  return withStorageTransaction(storage, async () => {
    const templates = await loadTaskTemplates(storage);
    const existing = templates.find((item) => item.id === templateId);
    if (!existing) throw new Error(`Task template not found: ${templateId}`);
    return maybeMutate("template.update", { templateId, templateName: existing.name }, confirm, async () => {
      const updated = updateTaskTemplate(existing, input);
      await saveTaskTemplates(
        storage,
        templates.map((item) => (item.id === templateId ? updated : item)),
      );
      return updated;
    });
  });
}

export async function applyTaskTemplate(
  storage: RuntimeStorage,
  api: EasyConsoleApi,
  templateId: string,
  confirm?: boolean,
  variableValues?: Record<string, string>,
  runLog?: BatchRunLogSink,
) {
  const templates = await loadTaskTemplates(storage);
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw new Error(`Task template not found: ${templateId}`);
  const payloads = taskTemplateToPayloads(template, undefined, variableValues);
  // Created tasks have no remote id until the batch runs, so the preview keys
  // payloads by their 1-based ordinal and shows the generated task name.
  const impact: BatchImpactItem[] = payloads.map((payload, index) => ({ id: index + 1, name: payload.name }));
  return maybeMutate(
    "template.apply",
    { templateId, templateName: template.name, count: payloads.length, variableValues },
    confirm,
    async () => {
      const batchId = createBatchId();
      const batch = await runBatch(payloads, {
        delayMs: BATCH_OPERATION_DELAY_MS,
        run: (payload) => api.instanceApi.createTask(payload),
      });
      const results: BatchItemReceipt[] = batch.outcomes.map((outcome, index) => ({
        id: impact[index]!.id,
        name: impact[index]!.name,
        ok: outcome.status === "succeeded",
        error: outcome.error,
      }));
      await appendBatchItemRunLogs(runLog, { action: "template.apply", batchId, items: results });
      const created = results.filter((item) => item.ok).length;
      // Remote calls are kept outside the lock so a slow API cannot block other
      // processes. Re-read inside the transaction because `templates` is now a
      // stale snapshot from before those calls. Usage counts only when at
      // least one task was actually created.
      if (created > 0) {
        await withStorageTransaction(storage, async () => {
          const current = await loadTaskTemplates(storage);
          await saveTaskTemplates(
            storage,
            current.map((item) => (item.id === templateId ? recordTaskTemplateUsage(item) : item)),
          );
        });
      }
      return { batchId, created, results };
    },
    { impact },
  );
}

export async function deleteTaskTemplate(storage: RuntimeStorage, templateId: string, confirm?: boolean) {
  return withStorageTransaction(storage, async () => {
    const templates = await loadTaskTemplates(storage);
    const template = templates.find((item) => item.id === templateId);
    if (!template) throw new Error(`Task template not found: ${templateId}`);
    return maybeMutate("template.delete", { templateId, templateName: template.name }, confirm, async () => {
      const remaining = templates.filter((item) => item.id !== templateId);
      await saveTaskTemplates(storage, remaining);
      return { deleted: true };
    });
  });
}

// === Local data: Scheduled tasks ===

export async function listScheduledTasks(storage: RuntimeStorage) {
  return loadScheduledTasks(storage);
}

export async function createScheduledTaskRecord(
  storage: RuntimeStorage,
  input: {
    name: string;
    description?: string;
    scheduleTime: string;
    payload: CreateTaskPayload;
    recurrence?: TaskRecurrence;
  },
  confirm?: boolean,
) {
  const { previewNextRuns } = await import("../../src/lib/task-recurrence");
  const draft = createScheduledTask(input);
  const nextRuns = previewNextRuns(draft, 5).map((date) => date.toISOString());
  return maybeMutate(
    "schedule.create",
    { task: draft, nextRuns },
    confirm,
    async () =>
      withStorageTransaction(storage, async () => {
        const items = await loadScheduledTasks(storage);
        await saveScheduledTasks(storage, [...items, draft]);
        return draft;
      }),
  );
}

export async function updateScheduledTaskRecord(
  storage: RuntimeStorage,
  taskId: string,
  patch: Partial<Pick<ScheduledTask, "name" | "description" | "scheduleTime" | "payload" | "recurrence">>,
  confirm?: boolean,
) {
  return withStorageTransaction(storage, async () => {
    const items = await loadScheduledTasks(storage);
    const task = items.find((item) => item.id === taskId);
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
    const next: ScheduledTask = {
      ...task,
      ...patch,
      payload: patch.payload ?? task.payload,
    };
    return maybeMutate("schedule.update", { taskId, taskName: task.name, patch }, confirm, async () => {
      const updated = updateScheduledTask(items, next);
      await saveScheduledTasks(storage, updated);
      return updated.find((item) => item.id === taskId) ?? next;
    });
  });
}

export async function pauseScheduledTaskRecord(storage: RuntimeStorage, taskId: string, confirm?: boolean) {
  return withStorageTransaction(storage, async () => {
    const items = await loadScheduledTasks(storage);
    const task = items.find((item) => item.id === taskId);
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
    return maybeMutate("schedule.pause", { taskId, taskName: task.name }, confirm, async () => {
      const paused = pauseScheduledTask(task);
      await saveScheduledTasks(storage, updateScheduledTask(items, paused));
      return paused;
    });
  });
}

export async function resumeScheduledTaskRecord(storage: RuntimeStorage, taskId: string, confirm?: boolean) {
  return withStorageTransaction(storage, async () => {
    const items = await loadScheduledTasks(storage);
    const task = items.find((item) => item.id === taskId);
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
    return maybeMutate("schedule.resume", { taskId, taskName: task.name }, confirm, async () => {
      const resumed = resumeScheduledTask(task);
      await saveScheduledTasks(storage, updateScheduledTask(items, resumed));
      return resumed;
    });
  });
}

export async function runScheduledTask(
  storage: RuntimeStorage,
  api: EasyConsoleApi,
  taskId: string,
  confirm?: boolean,
  resolveAccountScope?: () => Promise<AccountScope>,
) {
  const items = await loadScheduledTasks(storage);
  const task = items.find((item) => item.id === taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  return maybeMutate("schedule.run", { taskId, taskName: task.name, executionKey: `${task.id}@${task.scheduleTime}` }, confirm, async () => {
    const scope = await resolveAccountScope?.();
    const executed = await executeScheduledTask(storage, taskId, {
      createTask: (payload) => api.instanceApi.createTask(payload),
      trigger: "cli",
      force: true,
      getAccountScope: scope ? () => scope : undefined,
      allowLegacyOwner: true,
    });
    if (executed.skipped) {
      return {
        result: { skipped: true, reason: executed.reason, remoteTaskId: executed.task.lastRemoteTaskId },
        task: executed.task,
      };
    }
    return { result: executed.result, task: executed.task };
  });
}

export async function deleteScheduledTask(storage: RuntimeStorage, taskId: string, confirm?: boolean) {
  return withStorageTransaction(storage, async () => {
    const items = await loadScheduledTasks(storage);
    const task = items.find((item) => item.id === taskId);
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
    return maybeMutate("schedule.delete", { taskId, taskName: task.name }, confirm, async () => {
      const remaining = items.filter((item) => item.id !== taskId);
      await saveScheduledTasks(storage, remaining);
      return { deleted: true };
    });
  });
}

// === Local data: Backup ===

export async function exportBackup(storage: RuntimeStorage, includeSecrets: boolean, credentialStorage = storage) {
  return exportLocalDataBackup({ storage, credentialStorage }, includeSecrets);
}

export async function importBackup(
  storage: RuntimeStorage,
  backupText: string,
  sections: LocalDataBackupSection[],
  confirm?: boolean,
  credentialStorage = storage,
) {
  const backup = parseLocalDataBackup(backupText);
  return maybeMutate("backup.import", { sections, includeSecrets: backup.includeSecrets }, confirm, () =>
    // Keep shared-key writes from interleaving with other processes. Credential
    // keys use their own adapter and are never written into the shared store.
    withStorageTransaction(storage, () => importLocalDataBackup({ storage, credentialStorage }, backup, sections)),
  );
}
