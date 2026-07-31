/**
 * Allocate unique instance names by appending `_1`, `_2`, … when a name is taken.
 * Example: base `XXX` → `XXX_1` when `XXX` already exists.
 */

const MAX_NAME_ATTEMPTS = 10_000;

export function formatNumberedTaskName(baseName: string, number: number) {
  const base = baseName.trim();
  if (!base) return "";
  if (number <= 0) return base;
  return `${base}_${number}`;
}

/**
 * Interpret `/instance/checkTaskName` (or similar) payload after envelope unwrap.
 * Returns true when the name can be used; false when it is taken.
 * Unknown shapes default to available so we do not invent suffixes without evidence.
 */
export function isTaskNameAvailableResponse(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    // Some backends use 0/1 flags where 1 means available or exists; prefer object forms.
    return raw === 0 || raw === 1 ? raw === 1 : true;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "ok", "available", "yes"].includes(normalized)) return true;
    if (["false", "0", "taken", "exists", "exist", "no", "unavailable"].includes(normalized)) return false;
    return true;
  }
  if (!raw || typeof raw !== "object") return true;

  const record = raw as Record<string, unknown>;
  if (typeof record.available === "boolean") return record.available;
  if (typeof record.isAvailable === "boolean") return record.isAvailable;
  if (typeof record.is_available === "boolean") return record.is_available;
  if (typeof record.exists === "boolean") return !record.exists;
  if (typeof record.exist === "boolean") return !record.exist;
  if (typeof record.isExist === "boolean") return !record.isExist;
  if (typeof record.is_exist === "boolean") return !record.is_exist;
  if (typeof record.taken === "boolean") return !record.taken;
  if (typeof record.data === "boolean") return record.data;
  if (record.data && typeof record.data === "object") {
    return isTaskNameAvailableResponse(record.data);
  }
  return true;
}

export async function nextUniqueTaskName(
  baseName: string,
  isAvailable: (name: string) => boolean | Promise<boolean>,
  reserved: Set<string> = new Set(),
): Promise<string> {
  const base = baseName.trim();
  if (!base) return base;

  for (let number = 0; number <= MAX_NAME_ATTEMPTS; number += 1) {
    const candidate = formatNumberedTaskName(base, number);
    if (reserved.has(candidate)) continue;
    if (await isAvailable(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Unable to allocate a unique task name for "${base}"`);
}

export async function allocateUniqueTaskNames(
  baseNames: string[],
  isAvailable: (name: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const reserved = new Set<string>();
  const result: string[] = [];
  for (const baseName of baseNames) {
    result.push(await nextUniqueTaskName(baseName, isAvailable, reserved));
  }
  return result;
}

export function createTaskNameAvailabilityChecker(checkTaskName: (name: string) => Promise<unknown>) {
  const cache = new Map<string, boolean>();

  return async (name: string) => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const available = isTaskNameAvailableResponse(await checkTaskName(name));
    cache.set(name, available);
    return available;
  };
}

/** When enabled, rewrite payload names so they do not collide with existing instances (or each other). */
export async function maybeAllocateUniqueCreateTaskNames<T extends { name?: string }>(
  payloads: T[],
  options: {
    enabled: boolean;
    checkTaskName: (name: string) => Promise<unknown>;
  },
): Promise<T[]> {
  if (!options.enabled || payloads.length === 0) return payloads;
  const bases = payloads.map((payload) => String(payload.name ?? "").trim());
  const names = await allocateUniqueTaskNames(bases, createTaskNameAvailabilityChecker(options.checkTaskName));
  return payloads.map((payload, index) => ({ ...payload, name: names[index] ?? payload.name }));
}
