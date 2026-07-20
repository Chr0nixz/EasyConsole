import type { ResourceSpec } from "./types";

export type PriceOption = {
  id: string;
  label: string;
  value: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ["data", "list", "items", "results", "prices", "resources"] as const) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function resourceLabel(spec: ResourceSpec, index: number) {
  const name = String(spec.name ?? spec.label ?? "").trim();
  const parts = [
    spec.cpu !== undefined ? `${spec.cpu}C` : null,
    spec.gpu !== undefined ? `${spec.gpu}GPU` : null,
    spec.memory !== undefined ? `${spec.memory}G` : null,
  ].filter(Boolean);
  if (name && parts.length > 0) return `${name} (${parts.join(" / ")})`;
  if (name) return name;
  if (parts.length > 0) return parts.join(" / ");
  return `Spec ${spec.id ?? index + 1}`;
}

export function normalizeResourceSpecs(raw: unknown): ResourceSpec[] {
  const specs: ResourceSpec[] = [];
  for (const [index, item] of unwrapList(raw).entries()) {
    if (!isRecord(item)) continue;
    const cpu = toFiniteNumber(item.cpu);
    const gpu = toFiniteNumber(item.gpu);
    const memory = toFiniteNumber(item.memory);
    const name = typeof item.name === "string" ? item.name : typeof item.label === "string" ? item.label : undefined;
    specs.push({
      ...item,
      id: (item.id as string | number | undefined) ?? index,
      name,
      cpu: cpu ?? undefined,
      gpu: gpu ?? undefined,
      memory: memory ?? undefined,
    });
  }
  return specs;
}

export function normalizePriceOptions(raw: unknown): PriceOption[] {
  const seen = new Set<string>();
  const options: PriceOption[] = [];

  for (const [index, item] of unwrapList(raw).entries()) {
    if (typeof item === "number" || typeof item === "string") {
      const value = toFiniteNumber(item);
      if (value === null || value <= 0) continue;
      const id = `price-${value}`;
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({ id, label: String(value), value });
      continue;
    }
    if (!isRecord(item)) continue;

    const value =
      toFiniteNumber(item.price) ??
      toFiniteNumber(item.value) ??
      toFiniteNumber(item.amount) ??
      toFiniteNumber(item.cost) ??
      toFiniteNumber(item.unit_price);
    if (value === null || value <= 0) continue;

    const id = String(item.id ?? item.key ?? `price-${value}-${index}`);
    if (seen.has(id)) continue;
    seen.add(id);

    const name = String(item.name ?? item.label ?? item.title ?? "").trim();
    options.push({
      id,
      label: name ? `${name} (${value})` : String(value),
      value,
    });
  }

  return options;
}

export function formatResourceSpecOption(spec: ResourceSpec, index: number) {
  return resourceLabel(spec, index);
}

export function findMatchingPriceOptionId(options: PriceOption[], price: string | number | undefined | null) {
  const value = toFiniteNumber(price);
  if (value === null) return "";
  return options.find((option) => option.value === value)?.id ?? "";
}

export function parsePositivePrice(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
