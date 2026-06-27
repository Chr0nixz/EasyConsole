import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { buildMonitorDashboardUrl, DEFAULT_MONITOR_DASHBOARD_URL } from "../../src/lib/monitor-dashboard-core";
import type { EasyConsoleApi } from "../../src/lib/api-factory";
import { exportLocalDataBackup, importLocalDataBackup, parseLocalDataBackup, type LocalDataBackupSection } from "../../src/lib/local-data-backup";
import { normalizeStoragePath } from "../../src/lib/remote-storage";
import { createScheduledTask, loadScheduledTasks, saveScheduledTasks } from "../../src/lib/scheduled-tasks";
import { loadTaskTemplates, saveTaskTemplates, taskTemplateToPayloads } from "../../src/lib/task-templates";
import type {
  CreateTaskPayload,
  ImageCommitPayload,
  RuntimeStorage,
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
};

export type DryRunMutationResult = {
  dryRun: true;
  action: string;
  payload: unknown;
  message: string;
};

export type MutationResult = ConfirmedMutationResult | DryRunMutationResult;

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

export async function writeBlobToFile(blob: Blob, outputPath: string) {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, Buffer.from(await blob.arrayBuffer()));
  return {
    path: resolvedPath,
    bytes: blob.size,
  };
}

export async function maybeMutate(action: string, payload: unknown, confirm: boolean | undefined, run: () => Promise<unknown>): Promise<MutationResult> {
  if (!confirm) {
    return {
      dryRun: true,
      action,
      payload,
      message: "Pass confirm=true or --yes to execute this mutation.",
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

export function releaseTask(api: EasyConsoleApi, taskId: string | number, confirm?: boolean) {
  return maybeMutate("task.release", { id: taskId }, confirm, () => api.instanceApi.operateTask(taskId));
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

export async function downloadStoragePath(api: EasyConsoleApi, path: string, outputPath?: string) {
  const normalizedPath = normalizeStoragePath(path);
  const result = await api.storageApi.transmit({ path: normalizedPath });
  const blob = result instanceof Blob ? result : new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const targetPath = outputPath ?? (basename(normalizedPath) || "easy-console-download");
  return {
    remotePath: normalizedPath,
    ...(await writeBlobToFile(blob, targetPath)),
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

export function deleteTasks(api: EasyConsoleApi, taskIds: Array<string | number>, confirm?: boolean) {
  return maybeMutate("task.deleteBatch", { ids: taskIds }, confirm, () => api.instanceApi.deleteTasks(taskIds));
}

export function checkTaskName(api: EasyConsoleApi, name: string) {
  return api.instanceApi.checkTaskName(name);
}

export async function downloadTask(api: EasyConsoleApi, query: UnknownRecord, outputPath?: string) {
  const blob = await api.instanceApi.downloadTask(query);
  const targetPath = outputPath ?? `task-${Date.now()}.zip`;
  return writeBlobToFile(blob, targetPath);
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

export async function downloadImage(api: EasyConsoleApi, imageId: string | number, outputPath?: string) {
  const blob = await api.imageApi.download(imageId);
  const targetPath = outputPath ?? `image-${imageId}.tar`;
  return writeBlobToFile(blob, targetPath);
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

export async function applyTaskTemplate(storage: RuntimeStorage, api: EasyConsoleApi, templateId: string, confirm?: boolean) {
  const templates = await loadTaskTemplates(storage);
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw new Error(`Task template not found: ${templateId}`);
  const payloads = taskTemplateToPayloads(template);
  return maybeMutate("template.apply", { templateId, templateName: template.name, count: payloads.length }, confirm, async () => {
    const results: unknown[] = [];
    for (const payload of payloads) {
      results.push(await api.instanceApi.createTask(payload));
    }
    return { created: results.length, results };
  });
}

export async function deleteTaskTemplate(storage: RuntimeStorage, templateId: string, confirm?: boolean) {
  const templates = await loadTaskTemplates(storage);
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw new Error(`Task template not found: ${templateId}`);
  return maybeMutate("template.delete", { templateId, templateName: template.name }, confirm, async () => {
    const remaining = templates.filter((item) => item.id !== templateId);
    await saveTaskTemplates(storage, remaining);
    return { deleted: true };
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
) {
  const items = await loadScheduledTasks(storage);
  const task = createScheduledTask(input);
  await saveScheduledTasks(storage, [...items, task]);
  return task;
}

export async function runScheduledTask(storage: RuntimeStorage, api: EasyConsoleApi, taskId: string, confirm?: boolean) {
  const items = await loadScheduledTasks(storage);
  const task = items.find((item) => item.id === taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  return maybeMutate("schedule.run", { taskId, taskName: task.name }, confirm, () => api.instanceApi.createTask(task.payload));
}

export async function deleteScheduledTask(storage: RuntimeStorage, taskId: string, confirm?: boolean) {
  const items = await loadScheduledTasks(storage);
  const task = items.find((item) => item.id === taskId);
  if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
  return maybeMutate("schedule.delete", { taskId, taskName: task.name }, confirm, async () => {
    const remaining = items.filter((item) => item.id !== taskId);
    await saveScheduledTasks(storage, remaining);
    return { deleted: true };
  });
}

// === Local data: Backup ===

export async function exportBackup(storage: RuntimeStorage, includeSecrets: boolean) {
  return exportLocalDataBackup(storage, includeSecrets);
}

export async function importBackup(storage: RuntimeStorage, backupText: string, sections: LocalDataBackupSection[], confirm?: boolean) {
  const backup = parseLocalDataBackup(backupText);
  return maybeMutate("backup.import", { sections, includeSecrets: backup.includeSecrets }, confirm, () =>
    importLocalDataBackup(storage, backup, sections),
  );
}
