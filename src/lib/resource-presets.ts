import { updateStorageValue } from "./storage-mutex";
import type { ResourcePreset, RuntimeStorage, UnknownRecord } from "./types";

export const RESOURCE_PRESETS_STORAGE_KEY = "easy-console.resourcePresets";

export type EditableResourcePreset = Omit<ResourcePreset, "id" | "createdAt" | "updatedAt">;

/** Form-facing preset values as string fields, mirroring create-task inputs. */
export type ResourcePresetFormValues = { cpu: string; gpu: string; memory: string };

/** Validated resource values without identity; combined with a name when saving. */
export type ResourcePresetValues = { cpu: number; gpu: number; memory: number };

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Parse string form values with the same rules as the create-task fields:
 * CPU > 0 (fractions allowed), GPU integer >= 0, memory integer >= 1.
 * Returns null when any value is invalid.
 */
export function parseResourcePresetValues(cpu: string, gpu: string, memory: string): ResourcePresetValues | null {
  const cpuValue = positiveNumber(cpu);
  const gpuValue = nonNegativeInteger(gpu);
  const memoryValue = positiveInteger(memory);
  if (cpuValue === null || gpuValue === null || memoryValue === null) return null;
  return { cpu: cpuValue, gpu: gpuValue, memory: memoryValue };
}

function normalizePreset(raw: unknown): ResourcePreset | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  const name = stringValue(raw.name).trim();
  if (!id || !name) return null;
  const cpu = positiveNumber(raw.cpu);
  const gpu = nonNegativeInteger(raw.gpu);
  const memory = positiveInteger(raw.memory);
  if (cpu === null || gpu === null || memory === null) return null;
  return {
    id,
    name,
    cpu,
    gpu,
    memory,
    createdAt: stringValue(raw.createdAt, new Date().toISOString()),
    updatedAt: stringValue(raw.updatedAt, new Date().toISOString()),
  };
}

export async function loadResourcePresets(storage: RuntimeStorage): Promise<ResourcePreset[]> {
  const raw = await storage.get(RESOURCE_PRESETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const presets = parsed.map(normalizePreset).filter((preset): preset is ResourcePreset => Boolean(preset));
    // Hand-edited or imported storage can hold duplicate (trimmed) names; chips
    // and upsert-by-name assume uniqueness, so keep the first of each name.
    const seen = new Set<string>();
    return presets.filter((preset) => {
      if (seen.has(preset.name)) return false;
      seen.add(preset.name);
      return true;
    });
  } catch {
    return [];
  }
}

export async function saveResourcePresets(storage: RuntimeStorage, presets: ResourcePreset[]) {
  await updateStorageValue(storage, RESOURCE_PRESETS_STORAGE_KEY, () => JSON.stringify(presets));
}

function newPresetId(date: Date) {
  return `${date.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Add a preset, or update the existing one in place when the trimmed name
 * already exists (keeping its id/createdAt). New presets are prepended.
 */
export function upsertResourcePreset(
  presets: ResourcePreset[],
  input: EditableResourcePreset,
  date = new Date(),
): ResourcePreset[] {
  const name = input.name.trim();
  if (!name) return presets;
  const index = presets.findIndex((preset) => preset.name === name);
  if (index >= 0) {
    const next = [...presets];
    const existing = next[index];
    next[index] = { ...existing, cpu: input.cpu, gpu: input.gpu, memory: input.memory, updatedAt: date.toISOString() };
    return next;
  }
  const now = date.toISOString();
  const preset: ResourcePreset = {
    ...input,
    name,
    id: newPresetId(date),
    createdAt: now,
    updatedAt: now,
  };
  return [preset, ...presets];
}

export function deleteResourcePreset(presets: ResourcePreset[], id: string): ResourcePreset[] {
  return presets.filter((preset) => preset.id !== id);
}

/** Compact resource summary in the same shape as the resources section hint. */
export function formatResourcePresetSummary(values: { cpu: number | string; gpu: number | string; memory: number | string }) {
  return `${values.cpu}C / ${values.gpu}GPU / ${values.memory}G`;
}

/** The same summary for one creation payload; a payload without a GPU count reads as 0. */
export function formatPayloadResources(payload: { cpu?: unknown; gpu?: unknown; memory?: unknown }) {
  const field = (value: unknown, fallback: string) => (typeof value === "number" || typeof value === "string" ? value : fallback);
  return formatResourcePresetSummary({ cpu: field(payload.cpu, "-"), gpu: field(payload.gpu, "0"), memory: field(payload.memory, "-") });
}
