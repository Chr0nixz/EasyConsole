import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { buildMonitorDashboardUrl, DEFAULT_MONITOR_DASHBOARD_URL } from "../../src/lib/monitor-dashboard-core";
import type { EasyConsoleApi } from "../../src/lib/api-factory";
import type { CreateTaskPayload, Task, TaskQuery, UnknownRecord } from "../../src/lib/types";

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

function normalizeStoragePath(path?: string | null) {
  if (!path) return "/";
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!normalized || normalized === ".") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

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
