import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName } from "./format";
import { i18nText } from "./i18n-text";
import { normalizeStoragePath } from "./remote-storage";
import type { CreateTaskPayload, RuntimeStorage, Task, TaskTemplate, UnknownRecord } from "./types";

export const TASK_TEMPLATES_STORAGE_KEY = "easy-console.taskTemplates";
export const MAX_TEMPLATE_BATCH_COUNT = 50;

export type EditableTaskTemplate = Omit<TaskTemplate, "id" | "usageCount" | "lastUsedAt" | "createdAt" | "updatedAt">;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function boundedBatchCount(value: unknown) {
  const count = positiveInteger(value, 1);
  return Math.min(Math.max(count, 1), MAX_TEMPLATE_BATCH_COUNT);
}

function normalizeReleaseCondition(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeTemplate(raw: unknown): TaskTemplate | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const name = stringValue(raw.name).trim();
  const imageId = stringValue(raw.imageId).trim();
  if (!id || !name || !imageId) return null;

  const condition = normalizeReleaseCondition(raw.releaseCondition);
  return {
    id,
    name,
    description: stringValue(raw.description).trim() || undefined,
    taskNamePrefix: stringValue(raw.taskNamePrefix, name).trim() || name,
    batchCount: boundedBatchCount(raw.batchCount),
    imageId,
    cpu: positiveNumber(raw.cpu, 4),
    gpu: nonNegativeInteger(raw.gpu, 0),
    memory: positiveInteger(raw.memory, 16),
    storagePath: normalizeStoragePath(stringValue(raw.storagePath, "/")),
    mountPath: stringValue(raw.mountPath, "/home/ubuntu"),
    releaseCondition: condition,
    releaseAfterHours: condition === 2 ? positiveNumber(raw.releaseAfterHours, 24) : undefined,
    workDirectory: condition === 3 ? stringValue(raw.workDirectory).trim() : undefined,
    scriptPath: condition === 3 ? stringValue(raw.scriptPath).trim() : undefined,
    usageCount: nonNegativeInteger(raw.usageCount, 0),
    lastUsedAt: stringValue(raw.lastUsedAt).trim() || undefined,
    createdAt: stringValue(raw.createdAt, new Date().toISOString()),
    updatedAt: stringValue(raw.updatedAt, new Date().toISOString()),
  };
}

export async function loadTaskTemplates(storage: RuntimeStorage) {
  const raw = await storage.get(TASK_TEMPLATES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTemplate).filter((template): template is TaskTemplate => Boolean(template));
  } catch {
    return [];
  }
}

export async function saveTaskTemplates(storage: RuntimeStorage, templates: TaskTemplate[]) {
  await storage.set(TASK_TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
}

export function createTaskTemplate(input: EditableTaskTemplate, date = new Date()): TaskTemplate {
  const now = date.toISOString();
  return {
    ...input,
    id: `${date.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTaskTemplate(existing: TaskTemplate, input: EditableTaskTemplate, date = new Date()): TaskTemplate {
  return {
    ...existing,
    ...input,
    updatedAt: date.toISOString(),
  };
}

export function recordTaskTemplateUsage(template: TaskTemplate, date = new Date()): TaskTemplate {
  return {
    ...template,
    usageCount: template.usageCount + 1,
    lastUsedAt: date.toISOString(),
    updatedAt: date.toISOString(),
  };
}

function getTaskNameForTemplate(task: Pick<Task, "id" | "name" | "task_name">) {
  return task.name || task.task_name || i18nText(`任务 ${task.id ?? ""}`, `Task ${task.id ?? ""}`).trim();
}

function sanitizeTaskNamePrefix(value: string) {
  const normalized = value
    .trim()
    .replace(/-tpl[a-zA-Z0-9]{1,10}-\d{12}(?:-\d+)?$/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "task";
}

function getTaskImageId(task: Task) {
  const value = task.image_id ?? task.img;
  return value === undefined || value === null || value === "" ? "" : String(value);
}

export function taskToEditableTaskTemplate(task: Task, username = ""): EditableTaskTemplate {
  const taskName = getTaskNameForTemplate(task);
  const releaseCondition = normalizeReleaseCondition(task.releace_conditions ?? task.release_condition);
  return {
    name: i18nText(`${taskName} 模板`, `${taskName} template`),
    description: i18nText(`从实例 ${taskName} 保存`, `Saved from instance ${taskName}`),
    taskNamePrefix: sanitizeTaskNamePrefix(taskName),
    batchCount: 1,
    imageId: getTaskImageId(task),
    cpu: positiveNumber(task.cpu, 4),
    gpu: nonNegativeInteger(task.gpu, 0),
    memory: positiveInteger(task.memory, 16),
    storagePath: normalizeStoragePath(stringValue(task.storage_path, username ? `/${username}` : "/")),
    mountPath: stringValue(task.mount_path, username ? `/home/ubuntu/${username}` : "/home/ubuntu"),
    releaseCondition,
    releaseAfterHours: releaseCondition === 2 ? 24 : undefined,
    workDirectory: releaseCondition === 3 ? stringValue(task.work_directory).trim() : undefined,
    scriptPath: releaseCondition === 3 ? stringValue(task.script_path).trim() : undefined,
  };
}

export function getTaskTemplateMarker(template: Pick<TaskTemplate, "id">) {
  const normalized = template.id.replace(/[^a-zA-Z0-9]/g, "");
  return `tpl${(normalized || template.id).slice(-10)}`;
}

export function formatTemplateTaskName(template: Pick<TaskTemplate, "id" | "taskNamePrefix">, index: number, total: number, date = new Date()) {
  const prefix = template.taskNamePrefix.trim() || "task";
  const baseName = `${prefix}-${getTaskTemplateMarker(template)}-${formatTaskDefaultName(date)}`;
  if (total === 1) return baseName;
  return `${baseName}-${String(index + 1).padStart(String(total).length, "0")}`;
}

export function taskMatchesTemplate(task: Pick<Task, "name" | "task_name">, template: Pick<TaskTemplate, "id">) {
  const marker = getTaskTemplateMarker(template);
  return [task.name, task.task_name].some((value) => typeof value === "string" && value.includes(`-${marker}-`));
}

const TEMPLATE_TASK_NAME_PATTERN = /^(.*)-tpl[a-zA-Z0-9]{1,10}-(\d{12})(?:-(\d+))?$/;

export type ParsedTemplateTaskName = {
  full: string;
  prefix: string;
  suffix: string;
};

export function parseTemplateTaskName(name: string): ParsedTemplateTaskName | null {
  const trimmed = name.trim();
  const match = trimmed.match(TEMPLATE_TASK_NAME_PATTERN);
  if (!match) return null;
  const prefix = match[1];
  const timestamp = match[2];
  const batch = match[3];
  if (!prefix || !timestamp) return null;
  return {
    full: trimmed,
    prefix,
    suffix: batch ? `${timestamp}-${batch}` : timestamp,
  };
}

function normalizeId(value: string) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function taskTemplateToPayloads(template: TaskTemplate, date = new Date()): CreateTaskPayload[] {
  const releaseTime = template.releaseCondition === 2
    ? formatDateTimeForApi(formatDateTimeLocalInput(addHours(date, template.releaseAfterHours ?? 24)))
    : undefined;

  return Array.from({ length: template.batchCount }, (_, index) => ({
    name: formatTemplateTaskName(template, index, template.batchCount, date),
    price: 1,
    cpu: template.cpu,
    gpu: template.gpu > 0 ? template.gpu : undefined,
    memory: template.memory,
    img: normalizeId(template.imageId),
    storage_path: normalizeStoragePath(template.storagePath),
    mount_path: template.mountPath,
    releace_conditions: template.releaseCondition,
    releace_time: releaseTime,
    work_directory: template.releaseCondition === 3 ? template.workDirectory : undefined,
    script_path: template.releaseCondition === 3 ? template.scriptPath : undefined,
  }));
}
