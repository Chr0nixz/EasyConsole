import { addHours, formatDateTimeForApi, formatDateTimeLocalInput, formatTaskDefaultName } from "./format";
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

function releaseCondition(value: unknown): 1 | 2 | 3 {
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

  const condition = releaseCondition(raw.releaseCondition);
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
